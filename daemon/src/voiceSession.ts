// VoiceSession state + runtime.
//
// Pure state core (`createVoiceSessionState`) is the part Vitest covers
// — it captures the room/session/delivery binding for one active voice
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
import { runChat, ChatError } from './chatSession.js';
import { XaiTtsSession, TTS_SAMPLE_RATE } from './ttsSession.js';
import { daemonToPhone, type DeliveryTarget, type PhoneToDaemon } from './protocol.js';
import { XaiSttSession } from './sttSession.js';
import { SignalClient, type SignalData } from './signal.js';
import {
  FRAME_10MS,
  WEBRTC_SAMPLE_RATE,
  pcmToFrames,
  resamplePcm,
} from './audio.js';

export interface VoiceSessionConfig {
  roomId: string;
  sessionId: string;
  delivery: DeliveryTarget;
}

export interface VoiceSessionState {
  roomId: string;
  handleStartTurn(): void;
  resetTurn(): void;
  close(): void;
  readonly turnInFlight: boolean;
  readonly closed: boolean;
  chatTarget(): { sessionId: string; delivery: DeliveryTarget };
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

// --- runtime ---------------------------------------------------------

const CONNECT_TIMEOUT_MS = 12_000;

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

interface AudioSourceLike {
  createTrack(): unknown;
  onData(frame: { samples: Int16Array; sampleRate: number; channelCount: number }): void;
}

interface MediaStreamLike {
  addTrack(track: unknown): void;
}

export interface VoiceSessionRuntimeOptions {
  apiKey: string;
  sttLanguage?: string;
  signalServer: string;
  iceServers: RTCIceServer[];
  hostPeerId: string;
  roomId: string;
  sessionId: string;
  delivery: DeliveryTarget;
  onClose: (roomId: string) => void;
}

export class VoiceSession {
  readonly roomId: string;
  private readonly state: VoiceSessionState;
  private readonly signalClient: SignalClient;
  private peer: SimplePeer.Instance | null = null;
  private remoteId: string | null = null;
  private connected = false;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private stt: XaiSttSession | null = null;
  private tts: XaiTtsSession | null = null;
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

  constructor(private readonly opts: VoiceSessionRuntimeOptions) {
    this.roomId = opts.roomId;
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
      this.acceptPhone(peerId, true);
    });

    this.signalClient.on('signal', (event) => {
      if (this.peer && this.remoteId === event.from && !this.peer.destroyed) {
        try {
          this.peer.signal(event.data as SignalPayload);
        } catch (err) {
          console.error(`[voice ${opts.roomId}] peer.signal failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
      this.acceptPhone(event.from, false, event.data as SignalPayload);
    });

    this.signalClient.subscribe();
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
    if (this.peer && !this.peer.destroyed) {
      if (this.remoteId === remoteId) {
        if (initialSignal) {
          try { this.peer.signal(initialSignal); } catch { /* ignore */ }
        }
        return;
      }
      if (!this.connected) {
        console.error(`[voice ${this.roomId}] replacing stale pending phone ${this.remoteId ?? 'unknown'} with ${remoteId}`);
        this.tearDownPeer('replace_stale_pending_phone');
      } else {
        console.error(`[voice ${this.roomId}] rejecting second phone ${remoteId} — one per room`);
        return;
      }
    }

    this.remoteId = remoteId;
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
      } catch (err) {
        console.error(`[voice ${this.roomId}] peer.signal (initial) failed: ${err instanceof Error ? err.message : err}`);
      }
    }
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
    if (msg.t === 'stt.start') {
      this.resetTurn('stt_restart');
      // Routing is room-bound — ignore any payload on stt.start.
      this.state.handleStartTurn();
      this.openStt();
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
  }

  private openStt(): void {
    console.error(`[voice ${this.roomId}] opening xAI STT session`);
    this.stt = new XaiSttSession(
      { apiKey: this.opts.apiKey, language: this.opts.sttLanguage },
      {
        onReady: () => {
          this.send(daemonToPhone.sttReady());
        },
        onPartial: (text, isFinal) => {
          this.send(daemonToPhone.sttPartial(text, isFinal));
        },
        onDone: (text) => {
          this.send(daemonToPhone.sttDone(text));
          this.stt = null;
          void this.runReplyTurn(text);
        },
        onError: (message) => {
          this.send(daemonToPhone.sttError(message));
          this.stt = null;
          this.state.resetTurn();
        },
        onClosed: () => {
          this.send(daemonToPhone.sttClosed());
        },
      },
    );
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
        apiKey: this.opts.apiKey,
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
      this.send(daemonToPhone.replyError(code));
      this.state.resetTurn();
      return;
    }
    this.chatAbort = null;
    if (!this.state.turnInFlight) return;
    this.send(daemonToPhone.replyDone(replyText));

    this.openTts(replyText);
  }

  private openTts(text: string): void {
    try {
      this.audioQueue = [];
      this.rawRemainder = Buffer.alloc(0);
      this.resampledRemainder = Buffer.alloc(0);
      this.audioPumpAwaitingDone = false;

      const useTrack = !!this.audioSource;
      this.tts = new XaiTtsSession(
        { apiKey: this.opts.apiKey, text },
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
      const errorMsg = err instanceof Error ? err.message : 'xai_tts_open_failed';
      this.send(daemonToPhone.ttsError(errorMsg));
      this.state.resetTurn();
    }
  }

  private resetTurn(_reason: string): void {
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
