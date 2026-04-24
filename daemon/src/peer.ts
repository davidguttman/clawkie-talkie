// PeerJS host-side peer for Clawkie-Talkie. Registers with the
// public PeerJS broker (peerjs.com) under a UUID token generated each
// session. The phone discovers the daemon via `?host=<uuid>` URL
// parameter.
//
// Orchestration: this module owns the full turn. Phone streams mic PCM
// in; daemon runs xAI STT, then xAI chat on the final transcript, then
// xAI TTS on the reply text, and streams the resulting PCM16 audio
// back to the phone on the same DataConnection. The browser never
// holds an xAI key.
//
// PeerJS is authored browser-first but its runtime works in Node when
// the expected WebRTC + WebSocket globals are present. We install those
// before importing peerjs so its module-level capability checks see
// them.

import ws from 'ws';
import wrtc from '@roamhq/wrtc';
import { runChat, ChatError } from './chatSession.js';
import { XaiTtsSession, TTS_SAMPLE_RATE } from './ttsSession.js';
import { daemonToPhone, type PhoneToDaemon } from './protocol.js';
import { XaiSttSession } from './sttSession.js';

type Mutable = Record<string, unknown>;
const g = globalThis as unknown as Mutable;
const w = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};
if (!g.WebSocket) g.WebSocket = ws;
if (!g.RTCPeerConnection) g.RTCPeerConnection = w.RTCPeerConnection;
if (!g.RTCSessionDescription) g.RTCSessionDescription = w.RTCSessionDescription;
if (!g.RTCIceCandidate) g.RTCIceCandidate = w.RTCIceCandidate;

const { Peer } = await import('peerjs');
type PeerType = InstanceType<typeof Peer>;

export interface DaemonPeerOptions {
  apiKey: string;
  sttLanguage?: string;
  peerId: string;
  sessionId: string;
  threadId?: string;
  onReady: (peerId: string) => void;
  onFatalError?: (err: Error) => void;
}

interface PeerDataConnection {
  peer: string;
  label: string;
  open: boolean;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'data', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export class DaemonPeer {
  private readonly peer: PeerType;
  private active: PeerDataConnection | null = null;
  private activeSessionId: string | null = null;
  private activeThreadId: string | null = null;
  private stt: XaiSttSession | null = null;
  private tts: XaiTtsSession | null = null;
  private chatAbort: AbortController | null = null;
  // Once we have a final transcript we pipeline chat → TTS. This flag
  // lets `reply.cancel` short-circuit whichever stage is live.
  private turnInFlight = false;

  constructor(private readonly opts: DaemonPeerOptions) {
    // Connect to public PeerJS broker (no custom signaling server)
    this.peer = new Peer(opts.peerId, {
      // Uses public PeerJS broker at 0.peerjs.com by default
      debug: 1,
    });

    this.peer.on('open', (id: string) => {
      console.error(`[peer] registered with public broker as ${id}`);
      opts.onReady(id);
    });

    this.peer.on('error', (err: Error) => {
      console.error(`[peer] error: ${err.message}`);
      opts.onFatalError?.(err);
    });

    this.peer.on('connection', (rawConn: unknown) => {
      const conn = rawConn as PeerDataConnection;
      // Parse sessionId and threadId from the connection label, if present.
      // The phone establishes the connection; we only accept connections
      // that match expected patterns so we don't accidentally bind to
      // random/unknown peers.
      const labelMatch = conn.label?.match(
        /^daemon:(?<sessionId>[a-f0-9\-]+)(?:\+(?<threadId>[a-f0-9\-]+))?$/
      );
      if (!labelMatch?.groups?.sessionId) {
        console.error(`[peer] rejecting connection with unexpected label "${conn.label}"`);
        try { conn.close(); } catch {} // silently drop
        return;
      }
      this.bindConnection(
        conn,
        labelMatch.groups.sessionId,
        labelMatch.groups.threadId ?? undefined
      );
    });

    this.peer.on('disconnected', () => {
      console.error('[peer] broker disconnected; attempting reconnect');
      try {
        this.peer.reconnect();
      } catch (err) {
        console.error('[peer] reconnect failed', err);
      }
    });
  }

  close(): void {
    this.resetTurn('daemon_shutdown');
    try {
      this.active?.close();
    } catch {
      // ignore
    }
    this.active = null;
    try {
      this.peer.destroy();
    } catch {
      // ignore
    }
  }

  private bindConnection(
    conn: PeerDataConnection,
    sessionId: string,
    threadId?: string,
  ): void {
    if (this.active) {
      console.error(`[peer] rejecting second phone ${conn.peer} — one at a time`);
      try {
        conn.close();
      } catch {
        // ignore
      }
      return;
    }
    this.active = conn;
    this.activeSessionId = sessionId;
    this.activeThreadId = threadId ?? null;
    console.error(
      `[peer] incoming connection from ${conn.peer} label=${conn.label} ` +
      `session=${sessionId} thread=${threadId ?? '(none)'}`
    );

    conn.on('open', () => {
      console.error('[peer] data connection open');
    });

    conn.on('close', () => {
      console.error('[peer] data connection closed');
      this.resetTurn('peer_closed');
      this.active = null;
      this.activeSessionId = null;
      this.activeThreadId = null;
    });

    conn.on('error', (err: Error) => {
      console.error(`[peer] conn error: ${err.message}`);
    });

    conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        let msg: PhoneToDaemon;
        try {
          msg = JSON.parse(data) as PhoneToDaemon;
        } catch {
          return;
        }
        this.handleControl(msg);
        return;
      }
      if (!this.stt) return;
      const bytes = toBytes(data);
      if (bytes) this.stt.sendAudio(bytes);
    });
  }

  private handleControl(msg: PhoneToDaemon): void {
    if (msg.t === 'stt.start') {
      this.resetTurn('stt_restart');
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

  private openStt(): void {
    console.error('[daemon] opening xAI STT session');
    this.stt = new XaiSttSession(
      { apiKey: this.opts.apiKey, language: this.opts.sttLanguage },
      {
        onReady: () => this.send(daemonToPhone.sttReady()),
        onPartial: (text, isFinal) =>
          this.send(daemonToPhone.sttPartial(text, isFinal)),
        onDone: (text) => {
          this.send(daemonToPhone.sttDone(text));
          this.stt = null;
          void this.runReplyTurn(text);
        },
        onError: (message) => {
          this.send(daemonToPhone.sttError(message));
          this.stt = null;
          this.turnInFlight = false;
        },
        onClosed: () => this.send(daemonToPhone.sttClosed()),
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
      this.send(daemonToPhone.replyError(code));
      this.turnInFlight = false;
      return;
    }
    this.chatAbort = null;
    if (!this.turnInFlight) return;
    this.send(daemonToPhone.replyDone(replyText));

    this.openTts(replyText);
  }

  private openTts(text: string): void {
    try {
      this.tts = new XaiTtsSession(
        { apiKey: this.opts.apiKey, text },
        {
          onOpen: () => {
            this.send(daemonToPhone.ttsStart(TTS_SAMPLE_RATE));
          },
          onAudio: (pcm) => {
            this.sendBinary(pcm);
          },
          onDone: () => {
            this.send(daemonToPhone.ttsDone());
            this.tts = null;
            this.turnInFlight = false;
          },
          onError: (message) => {
            this.send(daemonToPhone.ttsError(message));
            this.tts = null;
            this.turnInFlight = false;
          },
        },
      );
    } catch (err) {
      this.send(
        daemonToPhone.ttsError(err instanceof Error ? err.message : 'xai_tts_open_failed'),
      );
      this.turnInFlight = false;
    }
  }

  private resetTurn(reason: string): void {
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
    if (reason !== 'stt_restart') {
      // Swallow — log only at debug verbosity so normal cancels aren't noisy.
    }
  }

  private send(msg: unknown): void {
    if (!this.active || !this.active.open) return;
    try {
      this.active.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[peer] send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendBinary(pcm: Uint8Array): void {
    if (!this.active || !this.active.open) return;
    try {
      // Copy into a fresh ArrayBuffer-backed view so peerjs sees an
      // exclusively-owned buffer (not a view over a larger or shared one).
      const backing = new ArrayBuffer(pcm.byteLength);
      new Uint8Array(backing).set(pcm);
      this.active.send(backing);
    } catch (err) {
      console.error(`[peer] binary send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
