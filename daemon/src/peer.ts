// Daemon-side WebRTC peer for Clawkie-Talkie. Uses a rambly-style
// signaling server (SSE subscribe + HTTP POST signal) instead of a
// PeerJS broker. The daemon subscribes to a room named after its own
// UUID; the phone discovers the daemon via `?host=<uuid>` and joins the
// same room. When the phone announces, the daemon initiates a
// simple-peer connection backed by @roamhq/wrtc.
//
// Orchestration: this module owns the full turn. Phone streams mic PCM
// in; daemon runs xAI STT, then xAI chat on the final transcript, then
// xAI TTS on the reply text, and streams the resulting PCM16 audio back
// to the phone on the same DataChannel. The browser never holds an xAI
// key.

import wrtc from '@roamhq/wrtc';
import SimplePeer from 'simple-peer';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { runChat, ChatError } from './chatSession.js';
import { XaiTtsSession, TTS_SAMPLE_RATE } from './ttsSession.js';
import { daemonToPhone, type PhoneToDaemon } from './protocol.js';
import { XaiSttSession } from './sttSession.js';
import { SignalClient, type SignalData } from './signal.js';

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

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: wrtc as unknown as SimplePeer.Options['wrtc'],
      config: { iceServers: this.iceServers },
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
    this.clearConnectionTimeout();
    this.resetTurn(reason);
    try {
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.peer = null;
    this.remoteId = null;
    this.connected = false;
    this.activeSessionId = null;
    this.activeThreadId = null;
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

      this.tts = new XaiTtsSession(
        { apiKey: this.opts.apiKey, text },
        {
          onOpen: () => {
            this.send(daemonToPhone.ttsStart(TTS_SAMPLE_RATE));
            void this.sendDebugNotification('tts_audio_start', 'TTS streaming PCM audio');
          },
          onAudio: (pcm) => {
            this.sendBinary(pcm);
          },
          onDone: () => {
            this.send(daemonToPhone.ttsDone());
            this.tts = null;
            this.turnInFlight = false;
            void this.sendDebugNotification('tts_done', 'audio playback complete');
          },
          onError: (message) => {
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
      // Hand simple-peer a tightly-owned view so it doesn't surface a
      // shared/larger buffer over the wire.
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
