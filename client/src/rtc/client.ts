// Browser WebRTC client via PeerJS. The daemon is the host — it
// registered with the public PeerJS broker and published its assigned
// peer ID in the join URL. The phone dials that peer ID to open a
// reliable raw DataConnection carrying both JSON control frames and
// binary PCM16 audio for STT streaming.

import { Peer, type DataConnection } from 'peerjs';

export type RtcStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface ControlMessage {
  t: string;
  [key: string]: unknown;
}

export interface RtcClientOptions {
  hostPeerId: string;
  onStatusChange?: (status: RtcStatus, detail?: string) => void;
  onControlMessage?: (msg: ControlMessage) => void;
}

export class RtcClient {
  private readonly peer: Peer;
  private conn: DataConnection | null = null;
  private status: RtcStatus = 'idle';
  private closed = false;

  constructor(private readonly opts: RtcClientOptions) {
    this.peer = new Peer({ debug: 1 });

    this.peer.on('open', () => {
      // Broker assigned us an ID; now we can dial the host.
      this.dial();
    });

    this.peer.on('error', (err) => {
      console.error('[rtc] peer error', err);
      if (this.closed) return;
      this.setStatus('error', `peer:${err.type ?? err.message}`);
    });

    this.peer.on('disconnected', () => {
      // Broker dropped us. PeerJS can reconnect without a new ID.
      if (this.closed) return;
      try {
        this.peer.reconnect();
      } catch {
        // ignore — `error` will fire
      }
    });
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    // Actual connect happens in `peer.on('open')` once we have our own id.
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
      this.conn.send(bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ));
    } catch {
      // ignore — peer may have just closed
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
      // 'raw' — pass through strings + ArrayBuffers untouched; match
      // the daemon's JSON-control + PCM16-binary wire format.
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
      if (typeof data !== 'string') return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(data) as ControlMessage;
      } catch {
        return;
      }
      this.opts.onControlMessage?.(msg);
    });
  }

  private setStatus(status: RtcStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status, detail);
  }
}
