// Daemon-side WebRTC peer for Clawkie-Talkie. Uses a rambly-style
// signaling server (SSE subscribe + HTTP POST signal) instead of a
// PeerJS broker. The daemon subscribes to a room named after its own
// UUID; the phone discovers the daemon via `?host=<uuid>` and joins the
// same room. When the phone announces, the daemon initiates a
// simple-peer connection backed by @roamhq/wrtc.
//
// Orchestration: this module owns the full turn. Phone streams mic PCM
// in over the data channel; daemon runs xAI STT, then xAI chat on the
// final transcript, then xAI TTS on the reply text. Reply audio is fed
// into an outbound WebRTC MediaStream (RTCAudioSource → 48 kHz / 10 ms
// frames) so the phone plays it as ordinary remote media — the same
// shape Rambly's CLI uses, which is the only path that survives mobile
// browser autoplay/suspend rules in practice.

import wrtc from '@roamhq/wrtc';
import SimplePeer from 'simple-peer';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { runChat, ChatError } from './chatSession.js';
import { XaiTtsSession, TTS_SAMPLE_RATE } from './ttsSession.js';
import { daemonToPhone, type PhoneToDaemon } from './protocol.js';
import { XaiSttSession } from './sttSession.js';
import { SignalClient, type SignalData } from './signal.js';
import {
  FRAME_10MS,
  WEBRTC_SAMPLE_RATE,
  pcmToFrames,
  resamplePcm,
} from './audio.js';

const execAsync = promisify(exec);

const DEFAULT_SIGNAL_SERVER =
  process.env.SIGNAL_SERVER?.trim() || 'https://api.rambly.app';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

const CONNECT_TIMEOUT_MS = 12_000;

export interface DaemonPeerOptions {
  apiKey: string;
  sttLanguage?: string;
  peerId: string;
  sessionId: string;
  threadId?: string;
  signalServer?: string;
  iceServers?: RTCIceServer[];
  onReady: (peerId: string) => void;
  onFatalError?: (err: Error) => void;
}

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

export class DaemonPeer {
  private readonly signalClient: SignalClient;
  private readonly iceServers: RTCIceServer[];

  // One phone at a time. `peer` is the simple-peer instance; `remoteId`
  // is the phone's signaling peerId so we can route signals back.
  private peer: SimplePeer.Instance | null = null;
  private remoteId: string | null = null;
  private connected = false;
  private connectionTimeout: NodeJS.Timeout | null = null;

  private activeSessionId: string | null = null;
  private activeThreadId: string | null = null;
  private stt: XaiSttSession | null = null;
  private tts: XaiTtsSession | null = null;
  private chatAbort: AbortController | null = null;
  private turnInFlight = false;
  private readyAnnounced = false;

  // Outbound audio: created once per phone connection and kept alive
  // for the lifetime of that peer. Frames pushed during TTS are
  // delivered as ordinary WebRTC remote media on the phone.
  private audioSource: AudioSourceLike | null = null;
  private outboundStream: unknown = null;
  // Keepalive ping to keep the data channel + ICE/NAT path warm during
  // the silent gap between STT close and TTS start. Without this,
  // mobile clients on cellular have shown the peer dropping while the
  // daemon is mid-`openclaw agent` exec.
  private keepaliveInterval: NodeJS.Timeout | null = null;
  // 10 ms TTS frame queue + drain pump.
  private audioQueue: Int16Array[] = [];
  private audioPumpInterval: NodeJS.Timeout | null = null;
  private audioPumpAwaitingDone = false;
  private rawRemainder: Buffer = Buffer.alloc(0);
  private resampledRemainder: Buffer = Buffer.alloc(0);

  constructor(private readonly opts: DaemonPeerOptions) {
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;

    this.signalClient = new SignalClient({
      signalServer: opts.signalServer ?? DEFAULT_SIGNAL_SERVER,
      peerId: opts.peerId,
      roomName: opts.peerId,
    });

    this.signalClient.on('open', () => {
      console.error(`[peer] subscribed to signal server as ${opts.peerId}`);
      if (!this.readyAnnounced) {
        this.readyAnnounced = true;
        opts.onReady(opts.peerId);
      }
    });

    this.signalClient.on('error', (err) => {
      console.error(`[peer] signal error: ${err.message}`);
      // Reconnect logic is built into SignalClient; only fatal-out if
      // the signal server URL itself is broken (we treat anything else
      // as transient).
      if (err.message.includes('404') || err.message.includes('400')) {
        opts.onFatalError?.(err);
      }
    });

    this.signalClient.on('announce', ({ peerId }) => {
      // The phone has joined the room. Per the rambly convention, the
      // existing peer that receives the announce initiates.
      this.acceptPhone(peerId, true);
    });

    this.signalClient.on('signal', (event) => {
      if (this.peer && this.remoteId === event.from && !this.peer.destroyed) {
        try {
          this.peer.signal(event.data as SignalPayload);
        } catch (err) {
          console.error(`[peer] peer.signal failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
      // Signal arrived without an active peer — accept passively.
      this.acceptPhone(event.from, false, event.data as SignalPayload);
    });

    this.signalClient.subscribe();
  }

  close(): void {
    this.resetTurn('daemon_shutdown');
    try {
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    this.clearConnectionTimeout();
    try {
      this.signalClient.close();
    } catch {
      // ignore
    }
  }

  // Send a debug/activity notification to the configured thread/Discord channel.
  private async sendDebugNotification(tag: string, detail: string): Promise<void> {
    const threadId = this.activeThreadId ?? this.opts.threadId;
    if (!threadId) return;
    try {
      const message = `> _clawkie ${tag}: ${detail}`;
      const args = [
        'message', 'send',
        '--channel', 'discord',
        '--target', `channel:${threadId}`,
        '--message', message,
      ];
      const env = { XAI_API_KEY: this.opts.apiKey, ...process.env };
      await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, { env });
    } catch {
      // best-effort
    }
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
        console.error(`[peer] replacing stale pending phone ${this.remoteId ?? 'unknown'} with ${remoteId}`);
        this.tearDownPeer('replace_stale_pending_phone');
      } else {
        // Reject second phone — one connected phone at a time.
        console.error(`[peer] rejecting second phone ${remoteId} — one at a time`);
        return;
      }
    }

    if (this.peer && !this.peer.destroyed) {
      console.error(`[peer] rejecting second phone ${remoteId} — one at a time`);
      return;
    }

    this.remoteId = remoteId;
    this.activeSessionId = this.opts.sessionId;
    this.activeThreadId = this.opts.threadId ?? null;

    console.error(`[peer] establishing connection with phone=${remoteId} initiator=${initiator}`);

    const { stream } = this.openOutboundAudio();

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: wrtc as unknown as SimplePeer.Options['wrtc'],
      config: { iceServers: this.iceServers },
      streams: stream ? [stream as MediaStream] : undefined,
    });
    this.peer = peer;
    this.armConnectionTimeout(peer, remoteId);

    peer.on('signal', (data) => {
      if (this.peer !== peer || this.remoteId !== remoteId) return;
      void this.signalClient
        .sendSignal(remoteId, data as unknown as SignalData)
        .catch((err) => {
          console.error(`[peer] sendSignal failed: ${err instanceof Error ? err.message : err}`);
        });
    });

    peer.on('connect', () => {
      if (this.peer !== peer) return;
      this.clearConnectionTimeout();
      this.connected = true;
      console.error('[peer] data channel connected');
      this.startKeepalive();
    });

    peer.on('data', (data: unknown) => {
      if (this.peer !== peer) return;
      this.handlePeerData(data);
    });

    peer.on('close', () => {
      if (this.peer !== peer) return;
      console.error('[peer] data channel closed');
      this.tearDownPeer('peer_closed', peer);
    });

    peer.on('error', (err: Error) => {
      if (this.peer !== peer) return;
      console.error(`[peer] error: ${err.message}`);
      this.tearDownPeer('peer_error', peer);
    });

    if (initialSignal) {
      try {
        peer.signal(initialSignal);
      } catch (err) {
        console.error(`[peer] peer.signal (initial) failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private armConnectionTimeout(peer: SimplePeer.Instance, remoteId: string): void {
    this.clearConnectionTimeout();
    this.connectionTimeout = setTimeout(() => {
      if (this.peer !== peer || this.remoteId !== remoteId || this.connected || peer.destroyed) return;
      console.error(`[peer] connection timed out with phone=${remoteId}`);
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
    console.error(`[peer] tearDownPeer reason=${reason}`);
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
    this.activeSessionId = null;
    this.activeThreadId = null;
  }

  private openOutboundAudio(): { stream: unknown | null } {
    if (this.outboundStream) return { stream: this.outboundStream };
    const nonstandard = (wrtc as { nonstandard?: { RTCAudioSource?: new () => AudioSourceLike } })
      .nonstandard;
    const Ctor = nonstandard?.RTCAudioSource;
    const MediaStreamCtor = (wrtc as { MediaStream?: new () => MediaStreamLike }).MediaStream;
    if (!Ctor || !MediaStreamCtor) {
      console.error('[peer] wrtc.nonstandard.RTCAudioSource unavailable; outbound audio disabled');
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
      console.error(`[peer] failed to open outbound audio: ${err instanceof Error ? err.message : err}`);
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
    // Flush any leftover raw bytes through the resampler, then any
    // partial 48 kHz frame zero-padded to 10 ms.
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
          this.turnInFlight = false;
          void this.sendDebugNotification('tts_done', 'audio playback complete');
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
        console.error(`[peer] audioSource.onData failed: ${err instanceof Error ? err.message : err}`);
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
        console.error(`[peer] keepalive send failed: ${err instanceof Error ? err.message : err}`);
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
      this.activeSessionId = trimOrNull(msg.sessionId) ?? this.opts.sessionId;
      this.activeThreadId = trimOrNull(msg.threadId) ?? this.opts.threadId ?? null;
      this.turnInFlight = true;
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

  private async openStt(): Promise<void> {
    console.error('[daemon] opening xAI STT session');
    await this.sendDebugNotification('stt_start', 'user speaking...');

    this.stt = new XaiSttSession(
      { apiKey: this.opts.apiKey, language: this.opts.sttLanguage },
      {
        onReady: () => {
          this.send(daemonToPhone.sttReady());
          void this.sendDebugNotification('stt_ready', 'listening for speech');
        },
        onPartial: (text, isFinal) => {
          if (isFinal) {
            void this.sendDebugNotification('stt_done', `transcript: ${text}`);
          }
          this.send(daemonToPhone.sttPartial(text, isFinal));
        },
        onDone: (text) => {
          this.send(daemonToPhone.sttDone(text));
          this.stt = null;
          void this.sendDebugNotification('stt_session_closed', 'transcription complete');
          void this.runReplyTurn(text);
        },
        onError: (message) => {
          this.send(daemonToPhone.sttError(message));
          this.stt = null;
          this.turnInFlight = false;
          void this.sendDebugNotification('stt_error', `error: ${message}`);
        },
        onClosed: () => {
          this.send(daemonToPhone.sttClosed());
          void this.sendDebugNotification('stt_connection_closed', 'STT socket closed');
        },
      },
    );
  }

  private async runReplyTurn(transcript: string): Promise<void> {
    if (!this.turnInFlight) return;
    const trimmed = transcript.trim();
    if (!trimmed) {
      this.send(daemonToPhone.replyError('empty_transcript'));
      this.turnInFlight = false;
      return;
    }
    this.send(daemonToPhone.replyStart(trimmed));

    await this.sendDebugNotification('chat_start', `transcript: ${trimmed.slice(0, 40)}...`);

    this.chatAbort = new AbortController();
    let replyText: string;
    try {
      const result = await runChat(trimmed, {
        apiKey: this.opts.apiKey,
        signal: this.chatAbort.signal,
        sessionId: this.activeSessionId ?? this.opts.sessionId,
        threadId: this.activeThreadId ?? this.opts.threadId,
        deliver: true,
      });
      replyText = result.text;
    } catch (err) {
      this.chatAbort = null;
      if (!this.turnInFlight) return;
      const code = err instanceof ChatError ? err.code : 'reply_failed';
      const errorMsg = err instanceof Error ? err.message : 'unknown error';
      await this.sendDebugNotification('chat_error', `code: ${code}, error: ${errorMsg}`);
      this.send(daemonToPhone.replyError(code));
      this.turnInFlight = false;
      return;
    }
    this.chatAbort = null;
    if (!this.turnInFlight) return;
    this.send(daemonToPhone.replyDone(replyText));

    await this.sendDebugNotification('chat_done', 'reply ready');

    this.openTts(replyText);
  }

  private async openTts(text: string): Promise<void> {
    try {
      await this.sendDebugNotification('tts_start', 'opening TTS stream');

      this.audioQueue = [];
      this.rawRemainder = Buffer.alloc(0);
      this.resampledRemainder = Buffer.alloc(0);
      this.audioPumpAwaitingDone = false;

      const useTrack = !!this.audioSource;
      this.tts = new XaiTtsSession(
        { apiKey: this.opts.apiKey, text },
        {
          onOpen: () => {
            // When the outbound audio track is up, audio flows as
            // ordinary WebRTC remote media; tts.start is just a turn
            // marker. Without a track, fall back to PCM frames over
            // the data channel and announce the source rate so the
            // phone's WebAudio player can decode.
            this.send(daemonToPhone.ttsStart(useTrack ? WEBRTC_SAMPLE_RATE : TTS_SAMPLE_RATE));
            void this.sendDebugNotification(
              'tts_audio_start',
              useTrack ? 'TTS streaming via WebRTC track' : 'TTS streaming via data channel',
            );
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
              this.turnInFlight = false;
              void this.sendDebugNotification('tts_done', 'audio playback complete');
              return;
            }
            // Track path: drain remaining buffered samples through the
            // pump, then have the pump fire tts.done once the queue
            // empties so the phone's UI doesn't snap out of "speaking"
            // before audio actually finishes.
            this.flushTtsTail();
            this.audioPumpAwaitingDone = true;
            this.startAudioPump();
            if (this.audioQueue.length === 0) {
              this.audioPumpAwaitingDone = false;
              this.send(daemonToPhone.ttsDone());
              this.tts = null;
              this.turnInFlight = false;
              void this.sendDebugNotification('tts_done', 'audio playback complete');
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
            this.turnInFlight = false;
            void this.sendDebugNotification('tts_error', `error: ${message}`);
          },
        },
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'xai_tts_open_failed';
      this.send(daemonToPhone.ttsError(errorMsg));
      this.turnInFlight = false;
      await this.sendDebugNotification('tts_session_error', `failed to open: ${errorMsg}`);
    }
  }

  private resetTurn(_reason: string): void {
    this.turnInFlight = false;
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
      console.error(`[peer] send failed: ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[peer] binary send failed: ${err instanceof Error ? err.message : String(err)}`);
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

// Heuristic: control messages are JSON objects starting with '{'.
// PCM16 audio frames almost never start with 0x7B, so this is a
// reliable split.
function tryDecodeJsonText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  if (bytes[0] !== 0x7b /* { */) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function trimOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface AudioSourceLike {
  createTrack(): unknown;
  onData(frame: { samples: Int16Array; sampleRate: number; channelCount: number }): void;
}

interface MediaStreamLike {
  addTrack(track: unknown): void;
}
