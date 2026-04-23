// Browser WebRTC client via PeerJS. The daemon is the host — it runs a
// self-hosted PeerJS signaling server (see daemon/src/signaling.ts) and
// registers under a deterministic peer ID (`ct-daemon`). The phone
// reaches that server via same-origin `/peerjs` — in dev the Vite proxy
// forwards it to the daemon, in deployment (e.g. jump.sh) the hosting
// proxy does. This removes the hard dependency on the public PeerJS
// broker (peerjs.com), which is not reachable from jump.sh containers.
// The DataConnection itself still carries JSON control frames, binary
// PCM16 mic audio (phone → daemon), and binary PCM16 TTS audio
// (daemon → phone).

import { Peer, type DataConnection, type PeerOptions } from 'peerjs';

const SIGNALING_PATH = '/peerjs';

function sameOriginPeerOptions(): PeerOptions {
  const loc = window.location;
  const secure = loc.protocol === 'https:';
  // Prefer the explicit port from location; fall back to the standard
  // 443/80 when the browser omits it (typical on jump.sh / prod).
  const port = loc.port ? Number(loc.port) : secure ? 443 : 80;
  return {
    host: loc.hostname,
    port,
    path: SIGNALING_PATH,
    secure,
    debug: 1,
  };
}

export type RtcStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface ControlMessage {
  t: string;
  [key: string]: unknown;
}

export interface RtcClientOptions {
  hostPeerId: string;
  onStatusChange?: (status: RtcStatus, detail?: string) => void;
  onControlMessage?: (msg: ControlMessage) => void;
  onBinaryMessage?: (bytes: ArrayBuffer) => void;
}

export class RtcClient {
  private readonly peer: Peer;
  private conn: DataConnection | null = null;
  private status: RtcStatus = 'idle';
  private closed = false;

  constructor(private readonly opts: RtcClientOptions) {
    this.peer = new Peer(sameOriginPeerOptions());

    this.peer.on('open', () => {
      this.dial();
    });

    this.peer.on('error', (err) => {
      console.error('[rtc] peer error', err);
      if (this.closed) return;
      this.setStatus('error', `peer:${err.type ?? err.message}`);
    });

    this.peer.on('disconnected', () => {
      if (this.closed) return;
      try {
        this.peer.reconnect();
      } catch {
        // ignore — 'error' will fire
      }
    });
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
  }

  sendControl(msg: ControlMessage): void {
    if (!this.conn || !this.conn.open) return;
    try {
      this.conn.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[rtc] sendControl failed', err);
    }
  }

  sendBinary(bytes: ArrayBuffer | Uint8Array): void {
    if (!this.conn || !this.conn.open) return;
    try {
      this.conn.send(
        bytes instanceof ArrayBuffer
          ? bytes
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
    } catch {
      // ignore
    }
  }

  get currentStatus(): RtcStatus {
    return this.status;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn?.close();
    } catch {
      // ignore
    }
    this.conn = null;
    try {
      this.peer.destroy();
    } catch {
      // ignore
    }
    this.setStatus('closed');
  }

  private dial(): void {
    if (this.closed) return;
    const conn = this.peer.connect(this.opts.hostPeerId, {
      reliable: true,
      serialization: 'raw',
    });
    this.conn = conn;

    conn.on('open', () => this.setStatus('open'));

    conn.on('close', () => {
      if (!this.closed) this.setStatus('closed');
    });

    conn.on('error', (err: Error) => {
      if (this.closed) return;
      this.setStatus('error', `datachannel:${err.message}`);
    });

    conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        let msg: ControlMessage;
        try {
          msg = JSON.parse(data) as ControlMessage;
        } catch {
          return;
        }
        this.opts.onControlMessage?.(msg);
        return;
      }
      const ab = toArrayBuffer(data);
      if (ab) this.opts.onBinaryMessage?.(ab);
    });
  }

  private setStatus(status: RtcStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status, detail);
  }
}

function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    // Copy into a fresh ArrayBuffer so we're not handing out a view
    // over a SharedArrayBuffer (peerjs may surface either).
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(
      new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength),
    );
    return out;
  }
  return null;
}
