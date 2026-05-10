// VoiceSession state + runtime.
//
// Pure state core (`createVoiceSessionState`) is the part Vitest covers
// — it captures the room/session binding for one active voice
// session and tracks the in-flight-turn / closed flags.
//
// The runtime class (`VoiceSession`) owns the live WebRTC peer, STT,
// TTS, OpenClaw chat, audio plumbing, and keepalive for one
// deterministic per-session room. Multiple `VoiceSession` instances
// coexist inside one daemon process, one per rendezvous-derived
// `roomId`. None of the existing per-turn singleton fields from
// `peer.ts` survive — they all moved here so each room is isolated.

import wrtc from '@roamhq/wrtc';
import SimplePeer from 'simple-peer';
import { runChat, ChatError, type DeliveryTarget as ChatDeliveryTarget } from './chatSession.js';
import { OpenClawInferTtsSession, TTS_SAMPLE_RATE, type TtsSessionCallbacks, type TtsSessionOptions } from './ttsSession.js';
import { daemonHandshakeResponse, daemonToPhone, type ControlEventRecord, type DaemonToPhone, type DaemonToPhoneEvent, type PhoneToDaemon, type RecentSessionsSnapshot, type SttCatalog, type SttSelection, type TtsCatalog, type TtsSelection, type VoiceSettings, type VoiceTurnSnapshot } from './protocol.js';
import { OpenClawInferSttSession, type OpenClawInferSttSessionOptions } from './inferSttSession.js';
import type { SttSessionCallbacks } from './sttTypes.js';
import { createWasmVad, type SpeechDetector, type WasmVadOptions } from './vad.js';
import { SignalClient, type SignalData } from './signal.js';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind.js';
import { createEmptyTtsCatalog, defaultTtsCatalogCache } from './ttsCatalog.js';
import { createEmptySttCatalog, defaultSttCatalogCache } from './sttCatalog.js';
import { createEmptyRecentSessionsSnapshot, defaultRecentSessionsCache } from './recentSessions.js';

import {
  FRAME_10MS,
  WEBRTC_SAMPLE_RATE,
  pcmToFrames,
  resamplePcm,
} from './audio.js';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;
const RECENT_SESSIONS_SUBSCRIPTION_INTERVAL_MS = 60_000;
const MAX_CONTROL_HISTORY_EVENTS = 128;
const MAX_BUFFERED_TTS_TURN_BYTES = 64 * 1024 * 1024;

export interface VoiceSessionConfig {
  roomId: string;
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: ChatDeliveryTarget;
}

export interface VoiceSessionState {
  roomId: string;
  handleStartTurn(): void;
  resetTurn(): void;
  close(): void;
  readonly turnInFlight: boolean;
  readonly closed: boolean;
  chatTarget(): { sessionId: string; sessionKey?: string; channel?: string; target?: string; accountId?: string; delivery?: ChatDeliveryTarget };
}

export function createVoiceSessionState(config: VoiceSessionConfig): VoiceSessionState {
  let turnInFlight = false;
  let closed = false;

  return {
    roomId: config.roomId,
    handleStartTurn() {
      turnInFlight = true;
    },
    resetTurn() {
      turnInFlight = false;
    },
    close() {
      closed = true;
    },
    get turnInFlight() {
      return turnInFlight;
    },
    get closed() {
      return closed;
    },
    chatTarget() {
      return {
        sessionId: config.sessionId,
        ...(config.sessionKey ? { sessionKey: config.sessionKey } : {}),
        ...(config.channel ? { channel: config.channel } : {}),
        ...(config.target ? { target: config.target } : {}),
        ...(config.accountId ? { accountId: config.accountId } : {}),
        delivery: config.delivery,
      };
    },
  };
}

export type PhoneConnectionDecision = 'accept' | 'use_existing' | 'replace_existing';

export function decidePhoneConnection(input: {
  hasCurrentPeer: boolean;
  currentRemoteId: string | null;
  incomingRemoteId: string;
}): PhoneConnectionDecision {
  if (!input.hasCurrentPeer) return 'accept';
  if (input.currentRemoteId === input.incomingRemoteId) return 'use_existing';
  return 'replace_existing';
}

// --- runtime ---------------------------------------------------------

const CONNECT_TIMEOUT_MS = 12_000;
const REPLACED_REMOTE_IGNORE_TTL_MS = 30_000;
const STT_SAMPLE_RATE = 16000;
const TTS_CATALOG_LOAD_TIMEOUT_MS = 1_500;
const OPENAI_PROVIDER_ID = 'openai';
const LEGACY_CLAWKIE_TTS_VOICE_IDS = new Set(['eve', 'ara', 'rex', 'sal', 'leo']);

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

interface AudioSourceLike {
  createTrack(): unknown;
  onData(frame: { samples: Int16Array; sampleRate: number; channelCount: number }): void;
}

interface MediaStreamLike {
  addTrack(track: unknown): void;
}

// Canonical per-turn TTS PCM log. TTS callbacks append here exactly once;
// live data-channel sends, WebRTC frame staging, and reconnect replay all
// consume from this log instead of deciding whether audio should be retained.
interface TtsAudioTurn {
  turnId: number;
  text: string;
  sampleRate: number;
  chunks: Buffer[];
  byteLength: number;
  started: boolean;
  abandoned: boolean;
  complete: boolean;
  drained: boolean;
  overflowed: boolean;
  replayOnReconnect: boolean;
  replayFromChunkIndex: number;
  liveDataCursor: number;
}

export interface SttSessionLike {
  sendAudio(bytes: Uint8Array): void;
  signalAudioDone(): void | Promise<void>;
  close(): void;
}

export type SttSessionFactory = (
  opts: OpenClawInferSttSessionOptions,
  cb: SttSessionCallbacks,
) => SttSessionLike;

export type SpeechDetectorFactory = (opts: WasmVadOptions) => Promise<SpeechDetector>;

export interface TtsSessionLike {
  cancel(): void;
}

export type TtsSessionFactory = (
  opts: TtsSessionOptions,
  cb: TtsSessionCallbacks,
) => TtsSessionLike;

function sanitizeReplyFailureLogText(text: string): string {
  return text
    .replace(/("--message"\s+)"(?:\\.|[^"\\])*"/g, '$1"[redacted]"')
    .replace(/("-m"\s+)"(?:\\.|[^"\\])*"/g, '$1"[redacted]"')
    .replace(/(--message\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/(-m\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|credential|password)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/\b(token-[A-Za-z0-9_.-]+)\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function sanitizedErrorMessage(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error && err.message) parts.push(err.message);
  if (err && typeof err === 'object') {
    const maybe = err as { stderr?: unknown; stdout?: unknown };
    if (typeof maybe.stderr === 'string' && maybe.stderr.trim()) parts.push(maybe.stderr);
    if (typeof maybe.stdout === 'string' && maybe.stdout.trim()) parts.push(maybe.stdout);
  }
  return sanitizeReplyFailureLogText(parts.join(' ') || 'unknown');
}

export interface VoiceSessionRuntimeOptions {
  sttLanguage?: string;
  signalServer: string;
  iceServers: RTCIceServer[];
  hostPeerId: string;
  roomId: string;
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: ChatDeliveryTarget;
  voiceSettings?: VoiceSettings;
  sttSessionFactory?: SttSessionFactory;
  createSpeechDetector?: SpeechDetectorFactory;
  ttsSessionFactory?: TtsSessionFactory;
  ttsCatalogProvider?: () => Promise<TtsCatalog>;
  sttCatalogProvider?: () => Promise<SttCatalog>;
  recentSessionsProvider?: () => Promise<RecentSessionsSnapshot>;
  onClose: (roomId: string) => void;
}

export class VoiceSession {
  readonly roomId: string;
  private readonly state: VoiceSessionState;
  private readonly signalClient: SignalClient;
  private peer: SimplePeer.Instance | null = null;
  private remoteId: string | null = null;
  private peerInitiator = false;
  private acceptedOffer = false;
  private acceptedAnswer = false;
  private connected = false;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private stt: SttSessionLike | null = null;
  private tts: TtsSessionLike | null = null;
  private chatAbort: AbortController | null = null;
  private audioSource: AudioSourceLike | null = null;
  private outboundStream: unknown = null;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  // Resampled WebRTC frame staging for RTCAudioSource; canonical PCM lives in ttsAudioTurn.
  private audioFrameQueue: Int16Array[] = [];
  private audioPumpInterval: NodeJS.Timeout | null = null;
  private audioPumpAwaitingDone = false;
  private rawRemainder: Buffer = Buffer.alloc(0);
  private resampledRemainder: Buffer = Buffer.alloc(0);
  private closing = false;
  private ttsSelection: TtsSelection = {};
  private sttSelection: SttSelection = {};
  private sttOpenToken = 0;
  private turnToken = 0;
  private audioPumpTurnToken: number | null = null;
  private recentSessionsInterval: NodeJS.Timeout | null = null;
  private readonly replacedRemoteIds = new Set<string>();
  private readonly pendingCandidates = new Map<string, SignalPayload[]>();
  private controlEventId = 0;
  private lastPeerDetachEventId = 0;
  private lastPeerDetachAtMs: number | null = null;
  private lastUsedAtMsValue = Date.now();
  private readonly controlHistory: ControlEventRecord[] = [];
  private protocolUnsupported = false;
  private ttsAudioTurn: TtsAudioTurn | null = null;
  private turnSnapshot: VoiceTurnSnapshot = {
    inFlight: false,
    phase: 'idle',
    latestEventId: 0,
  };

  constructor(private readonly opts: VoiceSessionRuntimeOptions) {
    this.roomId = opts.roomId;
    this.ttsSelection = normalizeTtsSelection(opts.voiceSettings);
    this.sttSelection = normalizeSttSelection(opts.voiceSettings);
    this.state = createVoiceSessionState({
      roomId: opts.roomId,
      sessionId: opts.sessionId,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      delivery: opts.delivery,
    });

    // Signaling identity for the daemon side of this voice room. Each
    // VoiceSession joins its own deterministic per-session room so
    // browsers landing on `host:session-A` and `host:session-B` reach
    // independent peer/STT/TTS/chat lanes.
    this.signalClient = new SignalClient({
      signalServer: opts.signalServer,
      peerId: opts.roomId,
      roomName: opts.roomId,
    });

    this.signalClient.on('error', (err) => {
      console.error(`[voice ${opts.roomId}] signal error: ${err.message}`);
    });

    this.signalClient.on('announce', ({ peerId }) => {
      if (this.replacedRemoteIds.has(peerId)) return;
      this.acceptPhone(peerId, true);
    });

    this.signalClient.on('signal', (event) => {
      if (this.replacedRemoteIds.has(event.from)) return;
      const payload = event.data as SignalPayload;
      const livePeer = !!this.peer && this.remoteId === event.from && !this.peer.destroyed;
      const kind = classifySignal(payload);
      const action = decideIncomingSignal({ hasLivePeer: livePeer, kind });

      if (action === 'forward') {
        const decision = decideForwardToLivePeer(
          {
            initiator: this.peerInitiator,
            acceptedOffer: this.acceptedOffer,
            acceptedAnswer: this.acceptedAnswer,
          },
          kind,
        );
        if (decision !== 'forward') {
          console.error(`[voice ${opts.roomId}] dropping ${kind} from ${event.from}: ${decision}`);
          return;
        }
        try {
          this.peer!.signal(payload);
          if (kind === 'offer') this.acceptedOffer = true;
          if (kind === 'answer') this.acceptedAnswer = true;
        } catch (err) {
          console.error(`[voice ${opts.roomId}] peer.signal failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }

      if (action === 'create-non-initiator') {
        const buffered = this.pendingCandidates.get(event.from) ?? [];
        this.pendingCandidates.delete(event.from);
        this.acceptPhone(event.from, false, payload);
        if (this.peer && this.remoteId === event.from) {
          for (const cand of buffered) {
            try { this.peer.signal(cand); } catch (err) {
              console.error(`[voice ${opts.roomId}] replay candidate failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
        return;
      }

      if (action === 'buffer-candidate') {
        const list = this.pendingCandidates.get(event.from) ?? [];
        if (list.length >= MAX_BUFFERED_CANDIDATES_PER_PEER) return;
        list.push(payload);
        this.pendingCandidates.set(event.from, list);
        return;
      }

      console.error(`[voice ${opts.roomId}] ignoring ${kind} signal from ${event.from} with no live peer`);
    });

    this.signalClient.subscribe();
  }

  applyVoiceSettings(settings: VoiceSettings | null | undefined): void {
    this.touchActivity();
    this.ttsSelection = normalizeTtsSelection(settings);
    this.sttSelection = normalizeSttSelection(settings);
  }

  touchActivity(atMs = Date.now()): void {
    this.lastUsedAtMsValue = atMs;
  }

  get lastUsedAtMs(): number {
    return this.lastUsedAtMsValue;
  }

  get canEvictForVoiceSessionLimit(): boolean {
    const hasLivePeer = !!this.peer && !this.peer.destroyed;
    return !this.closing && !hasLivePeer && !this.connected && !this.state.turnInFlight;
  }

  // Test/manager hooks so callers can inspect the selection currently
  // applied to the next TTS turn.
  get currentTtsSelection(): TtsSelection {
    return { ...this.ttsSelection };
  }

  get currentTtsVoice(): string | undefined {
    return this.ttsSelection.voice;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.resetTurn('voice_session_closed');
    try {
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    this.pendingCandidates.clear();
    this.clearConnectionTimeout();
    this.stopKeepalive();
    this.stopRecentSessionsSubscription();
    this.closeOutboundAudio();
    try {
      this.signalClient.close();
    } catch {
      // ignore
    }
    this.state.close();
    this.opts.onClose(this.roomId);
  }

  private acceptPhone(remoteId: string, initiator: boolean, initialSignal?: SignalPayload): void {
    if (this.replacedRemoteIds.has(remoteId)) return;
    this.touchActivity();

    const decision = decidePhoneConnection({
      hasCurrentPeer: !!this.peer && !this.peer.destroyed,
      currentRemoteId: this.remoteId,
      incomingRemoteId: remoteId,
    });

    if (decision === 'use_existing') {
      if (initialSignal) {
        try { this.peer?.signal(initialSignal); } catch { /* ignore */ }
      }
      return;
    }

    if (decision === 'replace_existing') {
      if (!this.connected) {
        console.error(`[voice ${this.roomId}] replacing stale pending phone ${this.remoteId ?? 'unknown'} with ${remoteId}`);
        this.replaceCurrentPhone('replace_stale_pending_phone');
      } else {
        console.error(`[voice ${this.roomId}] replacing active phone ${this.remoteId ?? 'unknown'} with ${remoteId}`);
        this.replaceCurrentPhone('newer_phone_connected');
      }
    }

    this.protocolUnsupported = false;
    this.remoteId = remoteId;
    this.peerInitiator = initiator;
    this.acceptedOffer = false;
    this.acceptedAnswer = false;
    console.error(`[voice ${this.roomId}] establishing connection with phone=${remoteId} initiator=${initiator}`);

    const { stream } = this.openOutboundAudio();

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: wrtc as unknown as SimplePeer.Options['wrtc'],
      config: { iceServers: this.opts.iceServers },
      streams: stream ? [stream as MediaStream] : undefined,
    });
    this.peer = peer;
    this.armConnectionTimeout(peer, remoteId);

    peer.on('signal', (data) => {
      if (this.peer !== peer || this.remoteId !== remoteId) return;
      void this.signalClient
        .sendSignal(remoteId, data as unknown as SignalData)
        .catch((err) => {
          console.error(`[voice ${this.roomId}] sendSignal failed: ${err instanceof Error ? err.message : err}`);
        });
    });

    peer.on('connect', () => {
      if (this.peer !== peer) return;
      this.touchActivity();
      this.clearConnectionTimeout();
      this.connected = true;
      console.error(`[voice ${this.roomId}] data channel connected`);
      this.startKeepalive();
      this.sendCatchUpSnapshot(peer);
    });

    peer.on('data', (data: unknown) => {
      if (this.peer !== peer) return;
      this.handlePeerData(data);
    });

    peer.on('close', () => {
      if (this.peer !== peer) return;
      console.error(`[voice ${this.roomId}] data channel closed`);
      this.tearDownPeer('peer_closed', peer);
    });

    peer.on('error', (err: Error) => {
      if (this.peer !== peer) return;
      console.error(`[voice ${this.roomId}] error: ${err.message}`);
      this.tearDownPeer('peer_error', peer);
    });

    if (initialSignal) {
      try {
        peer.signal(initialSignal);
        const initialKind = classifySignal(initialSignal);
        if (initialKind === 'offer') this.acceptedOffer = true;
        if (initialKind === 'answer') this.acceptedAnswer = true;
      } catch (err) {
        console.error(`[voice ${this.roomId}] peer.signal (initial) failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private replaceCurrentPhone(reason: string): void {
    const previousPeer = this.peer;
    const previousRemoteId = this.remoteId;
    if (!previousPeer) return;

    if (previousRemoteId) this.ignoreReplacedRemote(previousRemoteId);
    if (this.connected && !previousPeer.destroyed) {
      this.sendToPeer(previousPeer, daemonToPhone.sessionReplaced(reason));
    }

    this.clearConnectionTimeout();
    this.stopKeepalive();
    this.stopRecentSessionsSubscription();
    this.closeOutboundAudio();
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    this.protocolUnsupported = false;
    this.lastPeerDetachEventId = this.controlEventId;
    this.lastPeerDetachAtMs = Date.now();

    setTimeout(() => {
      try {
        previousPeer.destroy();
      } catch {
        // ignore
      }
    }, 100).unref?.();
  }

  private ignoreReplacedRemote(remoteId: string): void {
    this.replacedRemoteIds.add(remoteId);
    this.pendingCandidates.delete(remoteId);
    setTimeout(() => {
      this.replacedRemoteIds.delete(remoteId);
    }, REPLACED_REMOTE_IGNORE_TTL_MS).unref?.();
  }

  private armConnectionTimeout(peer: SimplePeer.Instance, remoteId: string): void {
    this.clearConnectionTimeout();
    this.connectionTimeout = setTimeout(() => {
      if (this.peer !== peer || this.remoteId !== remoteId || this.connected || peer.destroyed) return;
      console.error(`[voice ${this.roomId}] connection timed out with phone=${remoteId}`);
      this.tearDownPeer('connect_timeout', peer);
    }, CONNECT_TIMEOUT_MS);
    this.connectionTimeout.unref?.();
  }

  private clearConnectionTimeout(): void {
    if (!this.connectionTimeout) return;
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
  }

  private tearDownPeer(reason: string, peer?: SimplePeer.Instance): void {
    if (peer && this.peer !== peer) return;
    this.touchActivity();
    console.error(`[voice ${this.roomId}] tearDownPeer reason=${reason}`);
    this.lastPeerDetachEventId = this.controlEventId;
    this.lastPeerDetachAtMs = Date.now();
    this.clearConnectionTimeout();
    this.stopKeepalive();
    this.stopRecentSessionsSubscription();
    try {
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.closeOutboundAudio();
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    this.protocolUnsupported = false;
  }

  private openOutboundAudio(): { stream: unknown | null } {
    if (this.outboundStream) return { stream: this.outboundStream };
    const nonstandard = (wrtc as { nonstandard?: { RTCAudioSource?: new () => AudioSourceLike } })
      .nonstandard;
    const Ctor = nonstandard?.RTCAudioSource;
    const MediaStreamCtor = (wrtc as { MediaStream?: new () => MediaStreamLike }).MediaStream;
    if (!Ctor || !MediaStreamCtor) {
      console.error(`[voice ${this.roomId}] wrtc.nonstandard.RTCAudioSource unavailable; outbound audio disabled`);
      return { stream: null };
    }
    try {
      const source = new Ctor();
      const track = source.createTrack();
      const stream = new MediaStreamCtor();
      stream.addTrack(track);
      this.audioSource = source;
      this.outboundStream = stream;
      return { stream };
    } catch (err) {
      console.error(`[voice ${this.roomId}] failed to open outbound audio: ${err instanceof Error ? err.message : err}`);
      this.audioSource = null;
      this.outboundStream = null;
      return { stream: null };
    }
  }

  private closeOutboundAudio(): void {
    if (this.state.turnInFlight && !this.closing) {
      const turn = this.ttsAudioTurn;
      if (turn?.turnId === this.turnToken) {
        if (turn.started) {
          this.abandonTtsAudioTurn(turn.turnId);
        } else {
          this.markTtsAudioReplayOnReconnect(turn.turnId, 0);
        }
      }
    }
    const shouldCompletePendingTrackTts = this.audioPumpAwaitingDone && this.state.turnInFlight && !this.closing;
    this.stopAudioPump();
    this.audioPumpTurnToken = null;
    this.audioFrameQueue = [];
    this.rawRemainder = Buffer.alloc(0);
    this.resampledRemainder = Buffer.alloc(0);
    this.audioSource = null;
    this.outboundStream = null;
    if (shouldCompletePendingTrackTts) {
      this.completeTtsTurn('tts_audio_transport_closed');
    }
  }

  private enqueueTtsPcm(pcm: Uint8Array): void {
    if (!this.audioSource) return;
    if (pcm.byteLength === 0) return;
    const chunk = Buffer.concat([this.rawRemainder, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
    const evenLen = chunk.length & ~1;
    this.rawRemainder = chunk.subarray(evenLen);
    if (evenLen === 0) return;
    const aligned = chunk.subarray(0, evenLen);

    const resampled = resamplePcm(aligned, TTS_SAMPLE_RATE, WEBRTC_SAMPLE_RATE);
    const merged = Buffer.concat([this.resampledRemainder, resampled]);
    const frameBytes = FRAME_10MS * 2;
    const wholeBytes = merged.length - (merged.length % frameBytes);
    if (wholeBytes > 0) {
      const framed = merged.subarray(0, wholeBytes);
      const frames = pcmToFrames(framed, FRAME_10MS);
      for (const f of frames) this.audioFrameQueue.push(f);
    }
    this.resampledRemainder = merged.subarray(wholeBytes);
    this.startAudioPump(this.turnToken);
  }

  private flushTtsTail(): void {
    if (this.rawRemainder.length >= 2) {
      const evenLen = this.rawRemainder.length & ~1;
      const aligned = this.rawRemainder.subarray(0, evenLen);
      const resampled = resamplePcm(aligned, TTS_SAMPLE_RATE, WEBRTC_SAMPLE_RATE);
      this.resampledRemainder = Buffer.concat([this.resampledRemainder, resampled]);
      this.rawRemainder = Buffer.alloc(0);
    }
    if (this.resampledRemainder.length >= 2) {
      const tailFrames = pcmToFrames(this.resampledRemainder, FRAME_10MS);
      for (const f of tailFrames) this.audioFrameQueue.push(f);
      this.resampledRemainder = Buffer.alloc(0);
    }
  }

  private startAudioPump(token: number): void {
    if (this.audioPumpInterval) return;
    if (!this.audioSource) return;
    this.audioPumpTurnToken = token;
    this.audioPumpInterval = setInterval(() => {
      if (this.audioPumpTurnToken !== token || !this.isTurnActive(token)) {
        this.stopAudioPump();
        return;
      }
      const source = this.audioSource;
      if (!source) {
        this.stopAudioPump();
        return;
      }
      const frame = this.audioFrameQueue.shift();
      if (!frame) {
        if (this.audioPumpAwaitingDone) {
          this.stopAudioPump();
          this.completeTtsTurn('tts_audio_pump_done');
        }
        return;
      }
      try {
        source.onData({ samples: frame, sampleRate: WEBRTC_SAMPLE_RATE, channelCount: 1 });
        this.markTtsAudioStarted(token);
      } catch (err) {
        console.error(`[voice ${this.roomId}] audioSource.onData failed: ${sanitizedErrorMessage(err)}`);
      }
    }, 10);
    this.audioPumpInterval.unref?.();
  }

  private stopAudioPump(): void {
    if (this.audioPumpInterval) {
      clearInterval(this.audioPumpInterval);
      this.audioPumpInterval = null;
      this.audioPumpTurnToken = null;
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveInterval) return;
    this.keepaliveInterval = setInterval(() => {
      if (!this.connected || !this.peer) return;
      try {
        this.peer.send(JSON.stringify({ t: 'keepalive' }));
      } catch (err) {
        console.error(`[voice ${this.roomId}] keepalive send failed: ${err instanceof Error ? err.message : err}`);
      }
    }, 3_000);
    this.keepaliveInterval.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  private handlePeerData(data: unknown): void {
    this.touchActivity();
    const bytes = toBytes(data);
    if (!bytes) return;
    const text = tryDecodeJsonText(bytes);
    if (text !== null) {
      let msg: PhoneToDaemon;
      try {
        msg = JSON.parse(text) as PhoneToDaemon;
      } catch {
        return;
      }
      this.handleControl(msg);
      return;
    }
    if (this.protocolUnsupported) return;
    if (this.stt) this.stt.sendAudio(bytes);
  }

  private handleControl(msg: PhoneToDaemon): void {
    if (this.protocolUnsupported) return;
    if (msg.t === 'client.hello') {
      const response = daemonHandshakeResponse(msg);
      this.sendConnectionScoped(response);
      if (response.t === 'daemon.unsupported') this.enterProtocolUnsupported();
      return;
    }
    if (msg.t === 'tts.catalog.request') {
      void this.sendTtsCatalog();
      return;
    }
    if (msg.t === 'stt.catalog.request') {
      void this.sendSttCatalog();
      return;
    }
    if (msg.t === 'sessions.list.request') {
      void this.sendRecentSessions('list');
      return;
    }
    if (msg.t === 'sessions.catalog.request') {
      void this.sendRecentSessions('catalog');
      return;
    }
    if (msg.t === 'sessions.list.subscribe') {
      this.startRecentSessionsSubscription();
      void this.sendRecentSessions('list');
      return;
    }
    if (msg.t === 'sessions.list.unsubscribe') {
      this.stopRecentSessionsSubscription();
      return;
    }
    if (msg.t === 'stt.start') {
      this.resetTurn('stt_restart');
      // Routing is room-bound — ignore any payload on stt.start.
      const token = this.beginTurn();
      void this.openStt(token);
      return;
    }
    if (msg.t === 'stt.audio.done') {
      this.stt?.signalAudioDone();
      return;
    }
    if (msg.t === 'stt.cancel') {
      this.resetTurn('stt_cancelled');
      return;
    }
    if (msg.t === 'reply.cancel') {
      this.resetTurn('reply_cancelled');
      return;
    }
    if (msg.t === 'settings.update') {
      this.applyVoiceSettings(msg.settings);
      return;
    }
  }

  private async sendTtsCatalog(): Promise<void> {
    try {
      const loadCatalog = this.opts.ttsCatalogProvider ?? (() => defaultTtsCatalogCache.get());
      const catalog = await loadCatalogWithTimeout(loadCatalog, TTS_CATALOG_LOAD_TIMEOUT_MS);
      this.send(daemonToPhone.ttsCatalog(catalog ?? createEmptyTtsCatalog()));
    } catch (err) {
      console.error(`[voice ${this.roomId}] TTS catalog load failed: ${sanitizedErrorMessage(err)}`);
      this.send(daemonToPhone.ttsCatalog(createEmptyTtsCatalog()));
    }
  }

  private async sendSttCatalog(): Promise<void> {
    try {
      const loadCatalog = this.opts.sttCatalogProvider ?? (() => defaultSttCatalogCache.get());
      const catalog = await loadCatalog();
      this.send(daemonToPhone.sttCatalog(catalog));
    } catch {
      this.send(daemonToPhone.sttCatalog(createEmptySttCatalog()));
    }
  }

  private startRecentSessionsSubscription(): void {
    if (this.recentSessionsInterval) return;
    this.recentSessionsInterval = setInterval(() => {
      void this.sendRecentSessions('list');
    }, RECENT_SESSIONS_SUBSCRIPTION_INTERVAL_MS);
    this.recentSessionsInterval.unref?.();
  }

  private stopRecentSessionsSubscription(): void {
    if (!this.recentSessionsInterval) return;
    clearInterval(this.recentSessionsInterval);
    this.recentSessionsInterval = null;
  }

  private async sendRecentSessions(format: 'list' | 'catalog' = 'list'): Promise<void> {
    const toMessage = format === 'catalog' ? daemonToPhone.sessionsCatalog : daemonToPhone.sessionsList;
    try {
      const loadSessions = this.opts.recentSessionsProvider ?? (() => defaultRecentSessionsCache.get());
      this.send(toMessage(await loadSessions()));
    } catch {
      this.send(toMessage(createEmptyRecentSessionsSnapshot()));
    }
  }

  private async openStt(token: number): Promise<void> {
    this.sttOpenToken = token;
    console.error(`[voice ${this.roomId}] opening OpenClaw infer STT session`);
    const createStt = this.opts.sttSessionFactory ?? ((opts, cb) => new OpenClawInferSttSession(opts, cb));
    const createSpeechDetector = this.opts.createSpeechDetector ?? createWasmVad;
    let speechDetector: SpeechDetector | undefined;
    let detectorDestroyed = false;
    const destroySpeechDetector = () => {
      if (detectorDestroyed) return;
      detectorDestroyed = true;
      try {
        speechDetector?.destroy?.();
      } catch {
        // best effort cleanup
      }
    };

    try {
      speechDetector = await createSpeechDetector({ sampleRate: STT_SAMPLE_RATE });
    } catch (err) {
      if (!this.isTurnActive(token)) return;
      console.error(`[voice ${this.roomId}] WASM VAD init failed; continuing without phrase chunks: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!this.isTurnActive(token)) {
      destroySpeechDetector();
      return;
    }

    const enablePhraseChunks = !!speechDetector;
    const sttModel = sttModelOverride(this.sttSelection);
    const sttOptions: OpenClawInferSttSessionOptions = {
      language: this.opts.sttLanguage,
      sampleRate: STT_SAMPLE_RATE,
      enablePhraseChunks,
      ...(sttModel ? { model: sttModel } : {}),
    };
    if (speechDetector) sttOptions.speechDetector = speechDetector;

    const session = createStt(
      sttOptions,
      {
        onReady: () => {
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.sttReady());
        },
        onPartial: (text, isFinal) => {
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.sttPartial(text, isFinal));
        },
        onDone: (text) => {
          destroySpeechDetector();
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.sttDone(text));
          this.stt = null;
          void this.runReplyTurn(text, token);
        },
        onError: (message) => {
          destroySpeechDetector();
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.sttError(sanitizeReplyFailureLogText(message)));
          this.stt = null;
          this.resetTurn('stt_error');
        },
        onClosed: () => {
          destroySpeechDetector();
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.sttClosed());
        },
      },
    );

    this.stt = {
      sendAudio: (bytes) => session.sendAudio(bytes),
      signalAudioDone: () => session.signalAudioDone(),
      close: () => {
        try {
          session.close();
        } finally {
          destroySpeechDetector();
        }
      },
    };
  }

  private async runReplyTurn(transcript: string, token: number): Promise<void> {
    if (!this.isTurnActive(token)) return;
    const trimmed = transcript.trim();
    if (!trimmed) {
      this.send(daemonToPhone.replyError('empty_transcript'));
      this.resetTurn('empty_transcript');
      return;
    }
    this.send(daemonToPhone.replyStart(trimmed));
    this.chatAbort = new AbortController();
    let replyText: string;
    try {
      const target = this.state.chatTarget();
      const result = await runChat(trimmed, {
        signal: this.chatAbort.signal,
        sessionId: target.sessionId,
        ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
        ...(target.channel ? { channel: target.channel } : {}),
        ...(target.target ? { target: target.target } : {}),
        ...(target.accountId ? { accountId: target.accountId } : {}),
        delivery: target.delivery,
        deliver: true,
      });
      if (!this.isTurnActive(token)) return;
      replyText = result.text;
    } catch (err) {
      this.chatAbort = null;
      if (!this.isTurnActive(token)) return;
      const code = err instanceof ChatError ? err.code : 'reply_failed';
      this.logReplyFailure(code, err);
      this.send(daemonToPhone.replyError(code));
      this.resetTurn('reply_error');
      return;
    }
    this.chatAbort = null;
    if (!this.isTurnActive(token)) return;
    this.send(daemonToPhone.replyDone(replyText));
    void this.openTtsAsync(replyText, token);
  }


  private logReplyFailure(code: string, err: unknown): void {
    const details = err && typeof err === 'object'
      ? (err as { details?: { rootMessage?: string; stderr?: string; exitCode?: string } }).details
      : undefined;
    const rootMessage = sanitizeReplyFailureLogText(
      details?.rootMessage ?? (err instanceof Error ? err.message : 'unknown'),
    );
    const stderr = details?.stderr ? sanitizeReplyFailureLogText(details.stderr) : undefined;
    const exitCode = details?.exitCode;
    const target = this.state.chatTarget();
    const delivery = target.delivery ? `${target.delivery.channel}:${target.delivery.target}` : 'explicit-reply-target-unresolved';
    const fields = [
      `[voice ${this.roomId}] reply failed`,
      `session=${sanitizeReplyFailureLogText(target.sessionId)}`,
      target.sessionKey ? `sessionKey=${sanitizeReplyFailureLogText(target.sessionKey)}` : undefined,
      target.channel ? `channel=${sanitizeReplyFailureLogText(target.channel)}` : undefined,
      target.target ? `target=${sanitizeReplyFailureLogText(target.target)}` : undefined,
      target.accountId ? `accountId=${sanitizeReplyFailureLogText(target.accountId)}` : undefined,
      `delivery=${sanitizeReplyFailureLogText(delivery)}`,
      `code=${sanitizeReplyFailureLogText(code)}`,
      exitCode ? `exit=${sanitizeReplyFailureLogText(exitCode)}` : undefined,
      `message=${rootMessage}`,
      stderr ? `stderr=${stderr}` : undefined,
    ].filter((field): field is string => Boolean(field));
    console.error(fields.join(' '));
  }

  private startTtsAudioTurn(token: number, text: string): void {
    this.ttsAudioTurn = {
      turnId: token,
      text,
      sampleRate: TTS_SAMPLE_RATE,
      chunks: [],
      byteLength: 0,
      started: false,
      abandoned: false,
      complete: false,
      drained: false,
      overflowed: false,
      replayOnReconnect: false,
      replayFromChunkIndex: 0,
      liveDataCursor: 0,
    };
  }

  private markTtsAudioReplayOnReconnect(token?: number, fromChunkIndex?: number): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.drained || turn.overflowed || turn.abandoned) return;
    if (token !== undefined && turn.turnId !== token) return;
    const replayStart = Math.max(0, Math.min(fromChunkIndex ?? 0, turn.chunks.length));
    turn.replayFromChunkIndex = turn.replayOnReconnect
      ? Math.min(turn.replayFromChunkIndex, replayStart)
      : replayStart;
    turn.replayOnReconnect = true;
  }

  private markTtsAudioStarted(token?: number): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.abandoned) return;
    if (token !== undefined && turn.turnId !== token) return;
    turn.started = true;
  }

  private abandonTtsAudioTurn(token?: number): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.drained) return;
    if (token !== undefined && turn.turnId !== token) return;
    turn.abandoned = true;
    turn.replayOnReconnect = false;
    turn.replayFromChunkIndex = 0;
  }

  private appendTtsAudioPcm(token: number, pcm: Uint8Array): { chunk: Buffer; retained: boolean } | null {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.turnId !== token || turn.drained || pcm.byteLength === 0) return null;
    const chunk = Buffer.from(pcm);
    if (turn.overflowed) return { chunk, retained: false };
    if (turn.byteLength + chunk.byteLength > MAX_BUFFERED_TTS_TURN_BYTES) {
      // The cap is only a reconnect-replay retention cap. Once exceeded, drop
      // the retained canonical replay log for this turn, but keep returning the
      // current/future live chunks so connected transports are not cut off.
      turn.chunks = [];
      turn.byteLength = 0;
      turn.overflowed = true;
      turn.replayOnReconnect = false;
      turn.replayFromChunkIndex = 0;
      turn.liveDataCursor = 0;
      console.error(`[voice ${this.roomId}] buffered TTS replay dropped: canonical queue exceeded ${MAX_BUFFERED_TTS_TURN_BYTES} bytes`);
      return { chunk, retained: false };
    }
    turn.chunks.push(chunk);
    turn.byteLength += chunk.byteLength;
    return { chunk, retained: true };
  }

  private drainLiveDataTtsAudio(token: number): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.turnId !== token || turn.drained || turn.overflowed || turn.abandoned) return;
    if (turn.replayOnReconnect) return;
    while (turn.liveDataCursor < turn.chunks.length) {
      const chunk = turn.chunks[turn.liveDataCursor];
      if (!this.sendBinary(chunk)) {
        if (turn.started) {
          this.abandonTtsAudioTurn(token);
        } else {
          this.markTtsAudioReplayOnReconnect(token, turn.liveDataCursor);
        }
        return;
      }
      this.markTtsAudioStarted(token);
      turn.liveDataCursor += 1;
    }
  }

  private markTtsAudioComplete(token: number): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.turnId !== token || turn.overflowed) return;
    turn.complete = true;
  }

  private clearTtsAudioTurn(): void {
    this.ttsAudioTurn = null;
  }

  private completeTtsTurn(reason: string): void {
    this.markTtsAudioComplete(this.turnToken);
    const audioTurn = this.ttsAudioTurn;
    if (
      audioTurn &&
      audioTurn.turnId === this.turnToken &&
      (audioTurn.abandoned || !audioTurn.replayOnReconnect || audioTurn.overflowed || audioTurn.replayFromChunkIndex >= audioTurn.chunks.length)
    ) {
      this.clearTtsAudioTurn();
    }
    this.audioPumpAwaitingDone = false;
    this.send(daemonToPhone.ttsDone());
    if (reason !== 'tts_audio_transport_closed' && this.connected && this.peer && !this.peer.destroyed) {
      this.drainTtsAudioReplay(this.peer);
    }
    this.tts = null;
    this.resetTurn(reason);
  }

  private drainTtsAudioReplay(peer: SimplePeer.Instance): void {
    const turn = this.ttsAudioTurn;
    if (!turn || turn.drained || !turn.complete || turn.overflowed) return;
    if (turn.abandoned) {
      this.clearTtsAudioTurn();
      return;
    }
    if (!turn.replayOnReconnect) return;
    const chunks = turn.chunks.slice(turn.replayFromChunkIndex);
    if (chunks.length === 0) {
      turn.drained = true;
      this.clearTtsAudioTurn();
      return;
    }
    if (!this.sendToPeer(peer, daemonToPhone.ttsStart(turn.sampleRate, {
      buffered: true,
      turnId: turn.turnId,
      text: turn.text,
    }))) return;
    for (const chunk of chunks) {
      if (!this.sendBinaryToPeer(peer, chunk, 'buffered binary send failed')) return;
    }
    if (!this.sendToPeer(peer, daemonToPhone.ttsDone())) return;
    turn.drained = true;
    this.clearTtsAudioTurn();
  }

  private async openTtsAsync(text: string, token: number): Promise<void> {
    try {
      this.audioFrameQueue = [];
      this.rawRemainder = Buffer.alloc(0);
      this.resampledRemainder = Buffer.alloc(0);
      this.audioPumpAwaitingDone = false;
      this.startTtsAudioTurn(token, text);
      const catalog = await this.loadTtsCatalogForTurn();
      if (!this.isTurnActive(token)) return;
      const useTrack = !!this.audioSource;
      const createTts = this.opts.ttsSessionFactory ?? ((opts, cb) => new OpenClawInferTtsSession(opts, cb));
      const request = buildTtsSessionRequest(text, this.ttsSelection, { catalog });
      this.tts = createTts(request, {
        onOpen: () => {
          if (!this.isTurnActive(token)) return;
          this.send(daemonToPhone.ttsStart(useTrack ? WEBRTC_SAMPLE_RATE : TTS_SAMPLE_RATE));
        },
        onAudio: (pcm) => {
          if (!this.isTurnActive(token)) return;
          const audio = this.appendTtsAudioPcm(token, pcm);
          if (!audio) return;
          if (useTrack) {
            const turn = this.ttsAudioTurn;
            if (this.connected && this.audioSource && turn && !turn.abandoned && (!turn.replayOnReconnect || turn.overflowed)) {
              this.enqueueTtsPcm(audio.chunk);
            } else if (audio.retained && !turn?.abandoned) {
              this.markTtsAudioReplayOnReconnect(token, 0);
            }
            return;
          }
          if (audio.retained) {
            this.drainLiveDataTtsAudio(token);
            return;
          }
          // Replay retention overflow must not cut off live connected
          // data-channel audio; only reconnect replay is dropped.
          this.sendBinary(audio.chunk);
        },
        onDone: () => {
          if (!this.isTurnActive(token)) return;
          this.markTtsAudioComplete(token);
          if (!useTrack || !this.audioSource) {
            this.completeTtsTurn('tts_done');
            return;
          }
          this.flushTtsTail(); this.audioPumpAwaitingDone = true; this.startAudioPump(token);
          if (this.audioFrameQueue.length === 0) {
            this.completeTtsTurn('tts_done');
          }
        },
        onError: (message) => {
          if (!this.isTurnActive(token)) return;
          this.clearTtsAudioTurn();
          this.stopAudioPump();
          this.audioFrameQueue = [];
          this.rawRemainder = Buffer.alloc(0);
          this.resampledRemainder = Buffer.alloc(0);
          this.audioPumpAwaitingDone = false;
          this.send(daemonToPhone.ttsError(sanitizeReplyFailureLogText(message)));
          this.tts = null;
          this.resetTurn('tts_error');
        },
      });
    } catch (err) {
      if (!this.isTurnActive(token)) return;
      this.clearTtsAudioTurn();
      console.error(`[voice ${this.roomId}] TTS open failed: ${sanitizedErrorMessage(err)}`);
      this.send(daemonToPhone.ttsError('openclaw_infer_tts_failed'));
      this.resetTurn('tts_open_failed');
    }
  }

  private async loadTtsCatalogForTurn(): Promise<TtsCatalog | null> {
    const loadCatalog = this.opts.ttsCatalogProvider ?? (() => defaultTtsCatalogCache.get());
    try { return await loadCatalogWithTimeout(loadCatalog, TTS_CATALOG_LOAD_TIMEOUT_MS); }
    catch (err) { console.error(`[voice ${this.roomId}] TTS catalog load failed: ${sanitizedErrorMessage(err)}`); return null; }
  }


  private beginTurn(): number {
    this.touchActivity();
    this.clearTtsAudioTurn();
    const token = ++this.turnToken;
    this.sttOpenToken = token;
    this.state.handleStartTurn();
    this.turnSnapshot = {
      inFlight: true,
      phase: 'recording',
      latestEventId: this.controlEventId,
    };
    return token;
  }

  private isTurnActive(token: number): boolean {
    return token === this.turnToken && this.state.turnInFlight && !this.closing && !this.protocolUnsupported;
  }

  private enterProtocolUnsupported(): void {
    this.protocolUnsupported = true;
    this.stopRecentSessionsSubscription();
    this.resetTurn('protocol_unsupported');
  }

  private resetTurn(reason: string): void {
    this.touchActivity();
    if (!['tts_done', 'tts_audio_pump_done', 'tts_audio_transport_closed'].includes(reason)) {
      this.clearTtsAudioTurn();
    }
    this.turnToken += 1;
    this.sttOpenToken = this.turnToken;
    this.state.resetTurn();
    try {
      this.stt?.close();
    } catch {
      // ignore
    }
    this.stt = null;
    try {
      this.tts?.cancel();
    } catch {
      // ignore
    }
    this.tts = null;
    this.stopAudioPump();
    this.audioFrameQueue = [];
    this.rawRemainder = Buffer.alloc(0);
    this.resampledRemainder = Buffer.alloc(0);
    this.audioPumpAwaitingDone = false;
    this.chatAbort?.abort();
    this.chatAbort = null;
  }

  private send(msg: DaemonToPhone): void {
    if (this.protocolUnsupported) return;
    if (msg.t === 'session.snapshot') return;
    const event = this.recordControlEvent(msg);
    const peer = this.peer;
    if (!peer || !this.connected) return;
    this.sendToPeer(peer, event.msg);
  }

  private sendConnectionScoped(msg: DaemonToPhone): void {
    if (msg.t === 'session.snapshot') return;
    const peer = this.peer;
    if (!peer || !this.connected) return;
    this.sendToPeer(peer, msg);
  }

  private recordControlEvent(msg: DaemonToPhoneEvent): ControlEventRecord {
    const event: ControlEventRecord = { id: ++this.controlEventId, msg };
    this.controlHistory.push(event);
    if (this.controlHistory.length > MAX_CONTROL_HISTORY_EVENTS) {
      this.controlHistory.splice(0, this.controlHistory.length - MAX_CONTROL_HISTORY_EVENTS);
    }
    this.updateTurnSnapshotFromEvent(event);
    return event;
  }

  private updateTurnSnapshotFromEvent(event: ControlEventRecord): void {
    const msg = event.msg;
    const base: VoiceTurnSnapshot = {
      ...this.turnSnapshot,
      inFlight: this.state.turnInFlight,
      latestEventId: event.id,
    };
    if (msg.t === 'stt.done') {
      this.turnSnapshot = { ...base, phase: 'thinking', userText: msg.text, error: undefined };
      return;
    }
    if (msg.t === 'reply.start') {
      this.turnSnapshot = { ...base, phase: 'thinking', userText: msg.text, error: undefined };
      return;
    }
    if (msg.t === 'reply.done') {
      this.turnSnapshot = { ...base, phase: 'reply_ready', replyText: msg.text, error: undefined };
      return;
    }
    if (msg.t === 'tts.start') {
      this.turnSnapshot = { ...base, phase: 'speaking', ttsSampleRate: msg.sample_rate, error: undefined };
      return;
    }
    if (msg.t === 'tts.done') {
      this.turnSnapshot = { ...base, inFlight: false, phase: 'complete', error: undefined };
      return;
    }
    if (msg.t === 'stt.error' || msg.t === 'reply.error' || msg.t === 'tts.error') {
      this.turnSnapshot = { ...base, inFlight: false, phase: 'error', error: msg.message };
      return;
    }
    this.turnSnapshot = base;
  }

  private sendCatchUpSnapshot(peer: SimplePeer.Instance): void {
    const events = this.controlHistory
      .filter((event) => event.id > this.lastPeerDetachEventId)
      .map((event) => ({ id: event.id, msg: event.msg }));
    const disconnectedMs = this.lastPeerDetachAtMs === null
      ? 0
      : Math.max(0, Date.now() - this.lastPeerDetachAtMs);
    this.sendToPeer(peer, daemonToPhone.sessionSnapshot({
      roomId: this.roomId,
      latestEventId: this.controlEventId,
      disconnectedMs,
      turn: { ...this.turnSnapshot, latestEventId: this.controlEventId },
      events,
    }));
    this.drainTtsAudioReplay(peer);
  }

  private sendToPeer(peer: SimplePeer.Instance, msg: unknown): boolean {
    try {
      peer.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error(`[voice ${this.roomId}] send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private sendBinary(pcm: Uint8Array): boolean {
    if (this.protocolUnsupported) return false;
    const peer = this.peer;
    if (!peer || !this.connected) return false;
    return this.sendBinaryToPeer(peer, pcm, 'binary send failed');
  }

  private sendBinaryToPeer(peer: SimplePeer.Instance, pcm: Uint8Array, label: string): boolean {
    try {
      const copy = new Uint8Array(pcm.byteLength);
      copy.set(pcm);
      peer.send(copy);
      return true;
    } catch (err) {
      console.error(`[voice ${this.roomId}] ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}


function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeTtsSelection(settings: VoiceSettings | null | undefined): TtsSelection {
  const settingsRecord = objectRecord(settings);
  const tts = objectRecord(settingsRecord.tts);
  const voice = trimmedString(tts.voice) ?? trimmedString(settingsRecord.voice);
  const providerId = trimmedString(tts.providerId);
  const model = trimmedString(tts.model);
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
  };
}

function ttsModelOverride(selection: TtsSelection): string | undefined {
  return selection.providerId && selection.model
    ? `${selection.providerId}/${selection.model}`
    : undefined;
}

export function buildTtsSessionRequest(
  text: string,
  selection: TtsSelection,
  options: { catalog?: TtsCatalog | null } = {},
): { text: string; model?: string; voice?: string } {
  const model = ttsModelOverride(selection);
  const providerId = trimmedString(selection.providerId);
  const voice = trimmedString(selection.voice);
  const forwardVoice = shouldForwardTtsVoice({ providerId, model, voice, catalog: options.catalog });
  return { text, ...(model ? { model } : {}), ...(forwardVoice && voice ? { voice } : {}) };
}

function shouldForwardTtsVoice(input: { providerId?: string; model?: string; voice?: string; catalog?: TtsCatalog | null }): boolean {
  if (!input.voice) return false;
  if (!input.model && !input.providerId) return false;
  const providerId = input.providerId?.toLowerCase();
  const provider = input.catalog?.providers.find((item) => item.id.toLowerCase() === providerId);
  if (provider) {
    if (provider.voices.length === 0) return true;
    return provider.voices.some((candidate) => candidate.id === input.voice);
  }
  if (providerId === OPENAI_PROVIDER_ID && LEGACY_CLAWKIE_TTS_VOICE_IDS.has(input.voice.toLowerCase())) return false;
  return true;
}

function loadCatalogWithTimeout<T>(loadCatalog: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); timeout.unref?.(); });
  return Promise.race([loadCatalog(), timeoutPromise]).finally(() => { if (timeout) clearTimeout(timeout); });
}


function normalizeSttSelection(settings: VoiceSettings | null | undefined): SttSelection {
  const settingsRecord = objectRecord(settings);
  const stt = objectRecord(settingsRecord.stt);
  const providerId = trimmedString(stt.providerId);
  const model = trimmedString(stt.model);
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  };
}

function sttModelOverride(selection: SttSelection): string | undefined {
  return selection.providerId && selection.model
    ? `${selection.providerId}/${selection.model}`
    : undefined;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  return null;
}

function tryDecodeJsonText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  if (bytes[0] !== 0x7b /* { */) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
