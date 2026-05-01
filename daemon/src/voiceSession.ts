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
import { daemonToPhone, type PhoneToDaemon, type SttCatalog, type SttSelection, type TtsCatalog, type TtsSelection, type VoiceSettings } from './protocol.js';
import { OpenClawInferSttSession, type OpenClawInferSttSessionOptions } from './inferSttSession.js';
import type { SttSessionCallbacks } from './sttTypes.js';
import { createWasmVad, type SpeechDetector, type WasmVadOptions } from './vad.js';
import { SignalClient, type SignalData } from './signal.js';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind.js';
import { createEmptyTtsCatalog, defaultTtsCatalogCache } from './ttsCatalog.js';
import { createEmptySttCatalog, defaultSttCatalogCache } from './sttCatalog.js';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;
import {
  FRAME_10MS,
  WEBRTC_SAMPLE_RATE,
  pcmToFrames,
  resamplePcm,
} from './audio.js';

export interface VoiceSessionConfig {
  roomId: string;
  sessionId: string;
  delivery?: ChatDeliveryTarget;
}

export interface VoiceSessionState {
  roomId: string;
  handleStartTurn(): void;
  resetTurn(): void;
  close(): void;
  readonly turnInFlight: boolean;
  readonly closed: boolean;
  chatTarget(): { sessionId: string; delivery?: ChatDeliveryTarget };
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
      return { sessionId: config.sessionId, delivery: config.delivery };
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

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

interface AudioSourceLike {
  createTrack(): unknown;
  onData(frame: { samples: Int16Array; sampleRate: number; channelCount: number }): void;
}

interface MediaStreamLike {
  addTrack(track: unknown): void;
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
    .replace(/(--message\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/(xai[_-]?api[_-]?key\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export interface VoiceSessionRuntimeOptions {
  sttLanguage?: string;
  signalServer: string;
  iceServers: RTCIceServer[];
  hostPeerId: string;
  roomId: string;
  sessionId: string;
  delivery?: ChatDeliveryTarget;
  voiceSettings?: VoiceSettings;
  sttSessionFactory?: SttSessionFactory;
  createSpeechDetector?: SpeechDetectorFactory;
  ttsSessionFactory?: TtsSessionFactory;
  ttsCatalogProvider?: () => Promise<TtsCatalog>;
  sttCatalogProvider?: () => Promise<SttCatalog>;
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
  private audioQueue: Int16Array[] = [];
  private audioPumpInterval: NodeJS.Timeout | null = null;
  private audioPumpAwaitingDone = false;
  private rawRemainder: Buffer = Buffer.alloc(0);
  private resampledRemainder: Buffer = Buffer.alloc(0);
  private closing = false;
  private ttsSelection: TtsSelection = {};
  private sttSelection: SttSelection = {};
  private sttOpenToken = 0;
  private readonly replacedRemoteIds = new Set<string>();
  private readonly pendingCandidates = new Map<string, SignalPayload[]>();

  constructor(private readonly opts: VoiceSessionRuntimeOptions) {
    this.roomId = opts.roomId;
    this.ttsSelection = normalizeTtsSelection(opts.voiceSettings);
    this.sttSelection = normalizeSttSelection(opts.voiceSettings);
    this.state = createVoiceSessionState({
      roomId: opts.roomId,
      sessionId: opts.sessionId,
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
    this.ttsSelection = normalizeTtsSelection(settings);
    this.sttSelection = normalizeSttSelection(settings);
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
      this.clearConnectionTimeout();
      this.connected = true;
      console.error(`[voice ${this.roomId}] data channel connected`);
      this.startKeepalive();
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
    this.resetTurn(reason);
    this.closeOutboundAudio();
    this.peer = null;
    this.remoteId = null;
    this.connected = false;

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
    console.error(`[voice ${this.roomId}] tearDownPeer reason=${reason}`);
    this.clearConnectionTimeout();
    this.stopKeepalive();
    this.resetTurn(reason);
    try {
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.closeOutboundAudio();
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    // The voice room is bound for the lifetime of the session — when
    // the phone drops, tear down the whole VoiceSession so the manager
    // can release the room and signal-client subscription.
    this.close();
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
    this.stopAudioPump();
    this.audioQueue = [];
    this.rawRemainder = Buffer.alloc(0);
    this.resampledRemainder = Buffer.alloc(0);
    this.audioSource = null;
    this.outboundStream = null;
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
      for (const f of frames) this.audioQueue.push(f);
    }
    this.resampledRemainder = merged.subarray(wholeBytes);
    this.startAudioPump();
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
      for (const f of tailFrames) this.audioQueue.push(f);
      this.resampledRemainder = Buffer.alloc(0);
    }
  }

  private startAudioPump(): void {
    if (this.audioPumpInterval) return;
    if (!this.audioSource) return;
    this.audioPumpInterval = setInterval(() => {
      const source = this.audioSource;
      if (!source) {
        this.stopAudioPump();
        return;
      }
      const frame = this.audioQueue.shift();
      if (!frame) {
        if (this.audioPumpAwaitingDone) {
          this.stopAudioPump();
          this.audioPumpAwaitingDone = false;
          this.send(daemonToPhone.ttsDone());
          this.tts = null;
          this.state.resetTurn();
        }
        return;
      }
      try {
        source.onData({
          samples: frame,
          sampleRate: WEBRTC_SAMPLE_RATE,
          channelCount: 1,
        });
      } catch (err) {
        console.error(`[voice ${this.roomId}] audioSource.onData failed: ${err instanceof Error ? err.message : err}`);
      }
    }, 10);
    this.audioPumpInterval.unref?.();
  }

  private stopAudioPump(): void {
    if (this.audioPumpInterval) {
      clearInterval(this.audioPumpInterval);
      this.audioPumpInterval = null;
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
    if (this.stt) this.stt.sendAudio(bytes);
  }

  private handleControl(msg: PhoneToDaemon): void {
    if (msg.t === 'tts.catalog.request') {
      void this.sendTtsCatalog();
      return;
    }
    if (msg.t === 'stt.catalog.request') {
      void this.sendSttCatalog();
      return;
    }
    if (msg.t === 'stt.start') {
      this.resetTurn('stt_restart');
      // Routing is room-bound — ignore any payload on stt.start.
      this.state.handleStartTurn();
      void this.openStt();
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
      const catalog = await loadCatalog();
      this.send(daemonToPhone.ttsCatalog(catalog));
    } catch {
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

  private async openStt(): Promise<void> {
    const token = ++this.sttOpenToken;
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
      if (token !== this.sttOpenToken || !this.state.turnInFlight) return;
      console.error(`[voice ${this.roomId}] WASM VAD init failed; continuing without phrase chunks: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (token !== this.sttOpenToken || !this.state.turnInFlight) {
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
          this.send(daemonToPhone.sttReady());
        },
        onPartial: (text, isFinal) => {
          this.send(daemonToPhone.sttPartial(text, isFinal));
        },
        onDone: (text) => {
          destroySpeechDetector();
          this.send(daemonToPhone.sttDone(text));
          this.stt = null;
          void this.runReplyTurn(text);
        },
        onError: (message) => {
          destroySpeechDetector();
          this.send(daemonToPhone.sttError(message));
          this.stt = null;
          this.state.resetTurn();
        },
        onClosed: () => {
          destroySpeechDetector();
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

  private async runReplyTurn(transcript: string): Promise<void> {
    if (!this.state.turnInFlight) return;
    const trimmed = transcript.trim();
    if (!trimmed) {
      this.send(daemonToPhone.replyError('empty_transcript'));
      this.state.resetTurn();
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
        delivery: target.delivery,
        deliver: true,
      });
      replyText = result.text;
    } catch (err) {
      this.chatAbort = null;
      if (!this.state.turnInFlight) return;
      const code = err instanceof ChatError ? err.code : 'reply_failed';
      this.logReplyFailure(code, err);
      this.send(daemonToPhone.replyError(code));
      this.state.resetTurn();
      return;
    }
    this.chatAbort = null;
    if (!this.state.turnInFlight) return;
    this.send(daemonToPhone.replyDone(replyText));

    this.openTts(replyText);
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
    const delivery = target.delivery ? `${target.delivery.channel}:${target.delivery.target}` : 'session-bound';
    const fields = [
      `[voice ${this.roomId}] reply failed`,
      `session=${sanitizeReplyFailureLogText(target.sessionId)}`,
      `delivery=${sanitizeReplyFailureLogText(delivery)}`,
      `code=${sanitizeReplyFailureLogText(code)}`,
      exitCode ? `exit=${sanitizeReplyFailureLogText(exitCode)}` : undefined,
      `message=${rootMessage}`,
      stderr ? `stderr=${stderr}` : undefined,
    ].filter((field): field is string => Boolean(field));
    console.error(fields.join(' '));
  }

  private openTts(text: string): void {
    try {
      this.audioQueue = [];
      this.rawRemainder = Buffer.alloc(0);
      this.resampledRemainder = Buffer.alloc(0);
      this.audioPumpAwaitingDone = false;

      const useTrack = !!this.audioSource;
      const createTts = this.opts.ttsSessionFactory ?? ((opts, cb) => new OpenClawInferTtsSession(opts, cb));
      const selection = this.ttsSelection;
      this.tts = createTts(
        buildTtsSessionRequest(text, selection),
        {
          onOpen: () => {
            this.send(daemonToPhone.ttsStart(useTrack ? WEBRTC_SAMPLE_RATE : TTS_SAMPLE_RATE));
          },
          onAudio: (pcm) => {
            if (useTrack) {
              this.enqueueTtsPcm(pcm);
            } else {
              this.sendBinary(pcm);
            }
          },
          onDone: () => {
            if (!useTrack) {
              this.send(daemonToPhone.ttsDone());
              this.tts = null;
              this.state.resetTurn();
              return;
            }
            this.flushTtsTail();
            this.audioPumpAwaitingDone = true;
            this.startAudioPump();
            if (this.audioQueue.length === 0) {
              this.audioPumpAwaitingDone = false;
              this.send(daemonToPhone.ttsDone());
              this.tts = null;
              this.state.resetTurn();
            }
          },
          onError: (message) => {
            this.stopAudioPump();
            this.audioQueue = [];
            this.rawRemainder = Buffer.alloc(0);
            this.resampledRemainder = Buffer.alloc(0);
            this.audioPumpAwaitingDone = false;
            this.send(daemonToPhone.ttsError(message));
            this.tts = null;
            this.state.resetTurn();
          },
        },
      );
    } catch (err) {
      this.send(daemonToPhone.ttsError('openclaw_infer_tts_failed'));
      this.state.resetTurn();
    }
  }

  private resetTurn(_reason: string): void {
    this.sttOpenToken += 1;
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
    this.audioQueue = [];
    this.rawRemainder = Buffer.alloc(0);
    this.resampledRemainder = Buffer.alloc(0);
    this.audioPumpAwaitingDone = false;
    this.chatAbort?.abort();
    this.chatAbort = null;
  }

  private send(msg: unknown): void {
    const peer = this.peer;
    if (!peer || !this.connected) return;
    this.sendToPeer(peer, msg);
  }

  private sendToPeer(peer: SimplePeer.Instance, msg: unknown): void {
    try {
      peer.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[voice ${this.roomId}] send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendBinary(pcm: Uint8Array): void {
    const peer = this.peer;
    if (!peer || !this.connected) return;
    try {
      const copy = new Uint8Array(pcm.byteLength);
      copy.set(pcm);
      peer.send(copy);
    } catch (err) {
      console.error(`[voice ${this.roomId}] binary send failed: ${err instanceof Error ? err.message : String(err)}`);
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
): { text: string; model?: string; voice?: string } {
  const model = ttsModelOverride(selection);
  const providerId = trimmedString(selection.providerId);
  const voice = trimmedString(selection.voice);
  const forwardVoice = voice && (model || providerId);
  return {
    text,
    ...(model ? { model } : {}),
    ...(forwardVoice ? { voice } : {}),
  };
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
