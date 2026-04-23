// PeerJS host-side peer for Clawkie-Talkie. Registers with the public
// PeerJS broker (peerjs.com) and waits for incoming DataConnections.
// LobsterLink's convention: the printed join URL carries the assigned
// peer ID and the phone client calls `peer.connect(<hostId>)`.
//
// PeerJS is authored browser-first but its runtime works in Node when
// the expected WebRTC + WebSocket globals are present. We install those
// before importing peerjs so its module-level capability checks see them.

import ws from 'ws';
import wrtc from '@roamhq/wrtc';
import type { XaiSttSession } from './sttSession.js';

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
type DataConnection = Parameters<Parameters<PeerType['on']>[1] extends (conn: infer C) => unknown ? never : never>[0];

export interface DaemonPeerOptions {
  openSttSession: (send: (msg: string | Uint8Array) => void) => XaiSttSession;
  onReady: (peerId: string) => void;
  onFatalError?: (err: Error) => void;
}

type ControlMessageIn =
  | { t: 'stt.start' }
  | { t: 'stt.audio.done' }
  | { t: 'stt.cancel' };

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
  private sttSession: XaiSttSession | null = null;

  constructor(private readonly opts: DaemonPeerOptions) {
    this.peer = new Peer({ debug: 1 });

    this.peer.on('open', (id: string) => {
      console.error(`[peer] registered with broker as ${id}`);
      opts.onReady(id);
    });

    this.peer.on('error', (err: Error) => {
      console.error(`[peer] error: ${err.message}`);
      // PeerJS's `error` event fires for both recoverable + fatal; the
      // fatal ones ('peer-unavailable', 'network', 'browser-incompatible')
      // leave the peer unusable. Let the caller decide what to do.
      opts.onFatalError?.(err);
    });

    this.peer.on('connection', (conn: unknown) => {
      this.bindConnection(conn as PeerDataConnection);
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
    this.sttSession?.close();
    this.sttSession = null;
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

  private bindConnection(conn: PeerDataConnection): void {
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
    console.error(`[peer] incoming connection from ${conn.peer} label=${conn.label}`);

    const send = (msg: string | Uint8Array) => {
      if (!this.active) return;
      try {
        if (typeof msg === 'string') {
          this.active.send(msg);
        } else {
          // Copy into a fresh ArrayBuffer-backed view so peerjs sees a
          // clean, exclusively-owned buffer (not a view over a larger
          // or shared one).
          const backing = new ArrayBuffer(msg.byteLength);
          new Uint8Array(backing).set(msg);
          this.active.send(backing);
        }
      } catch (err) {
        console.error(`[peer] send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    conn.on('open', () => {
      console.error('[peer] data connection open');
    });

    conn.on('close', () => {
      console.error('[peer] data connection closed');
      this.sttSession?.close();
      this.sttSession = null;
      this.active = null;
    });

    conn.on('error', (err: Error) => {
      console.error(`[peer] conn error: ${err.message}`);
    });

    conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        let msg: ControlMessageIn;
        try {
          msg = JSON.parse(data) as ControlMessageIn;
        } catch {
          return;
        }
        if (msg.t === 'stt.start') {
          this.sttSession?.close();
          this.sttSession = this.opts.openSttSession(send);
          return;
        }
        if (msg.t === 'stt.audio.done') {
          this.sttSession?.signalAudioDone();
          return;
        }
        if (msg.t === 'stt.cancel') {
          this.sttSession?.close();
          this.sttSession = null;
          return;
        }
        return;
      }

      if (!this.sttSession) return;
      const bytes = toBytes(data);
      if (bytes) this.sttSession.sendAudio(bytes);
    });
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
