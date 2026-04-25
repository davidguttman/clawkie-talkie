// Browser WebRTC client. Uses a rambly-style signaling server (SSE
// subscribe + HTTP POST signal) to discover the daemon, then connects
// over WebRTC via simple-peer.
//
// The phone joins a "room" named after the daemon's UUID (passed as the
// `?host=<uuid>` URL param). The daemon is already in that room; when
// the phone announces itself, the daemon initiates a simple-peer
// connection. The DataChannel carries JSON control frames + binary
// PCM16 audio.

import SimplePeer from 'simple-peer';
import { SignalClient, type SignalData, type SignalEvent } from './signal';

export type RtcStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface ControlMessage {
  t: string;
  [key: string]: unknown;
}

export interface RtcClientOptions {
  hostPeerId: string;
  signalServer?: string;
  iceServers?: RTCIceServer[];
  onStatusChange?: (status: RtcStatus, detail?: string) => void;
  onControlMessage?: (msg: ControlMessage) => void;
  onBinaryMessage?: (bytes: ArrayBuffer) => void;
}

const DEFAULT_SIGNAL_SERVER =
  typeof import.meta.env.VITE_SIGNAL_SERVER === 'string' && import.meta.env.VITE_SIGNAL_SERVER.length > 0
    ? import.meta.env.VITE_SIGNAL_SERVER
    : 'https://api.rambly.app';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

function randomPeerId(): string {
  // Short, opaque, URL-safe id for this browser session.
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  let s = '';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return `phone-${s}`;
}

export class RtcClient {
  private readonly signalClient: SignalClient;
  private readonly peerId: string;
  private peer: SimplePeer.Instance | null = null;
  private remotePeerId: string | null = null;
  private status: RtcStatus = 'idle';
  private closed = false;
  private readonly iceServers: RTCIceServer[];

  constructor(private readonly opts: RtcClientOptions) {
    this.peerId = randomPeerId();
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;

    this.signalClient = new SignalClient({
      signalServer: opts.signalServer ?? DEFAULT_SIGNAL_SERVER,
      peerId: this.peerId,
      roomName: opts.hostPeerId,
    });

    this.signalClient.on('open', () => {
      // Subscribed; the server will announce us to the daemon.
    });
    this.signalClient.on('error', (err) => {
      if (this.closed) return;
      this.setStatus('error', `signal:${err.message}`);
    });
    this.signalClient.on('announce', ({ peerId }) => {
      // The daemon (already in the room) is the one that initiates per
      // the rambly convention. The phone shouldn't initiate from announce
      // — the daemon will signal us first. We just remember who it is so
      // we can route signals.
      if (this.remotePeerId && this.remotePeerId !== peerId) return;
      this.remotePeerId = peerId;
    });
    this.signalClient.on('signal', (event: SignalEvent) => {
      this.handleSignal(event);
    });
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    this.signalClient.subscribe();
  }

  sendControl(msg: ControlMessage): void {
    const peer = this.peer;
    if (!peer || !peer.connected) return;
    try {
      peer.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[rtc] sendControl failed', err);
    }
  }

  sendBinary(bytes: ArrayBuffer | Uint8Array): void {
    const peer = this.peer;
    if (!peer || !peer.connected) return;
    try {
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      peer.send(view);
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
      this.peer?.destroy();
    } catch {
      // ignore
    }
    this.peer = null;
    try {
      this.signalClient.close();
    } catch {
      // ignore
    }
    this.setStatus('closed');
  }

  private handleSignal(event: SignalEvent): void {
    if (this.closed) return;
    if (this.peer && !this.peer.destroyed) {
      try {
        this.peer.signal(event.data as SignalPayload);
      } catch (err) {
        console.error('[rtc] peer.signal failed', err);
      }
      return;
    }
    this.remotePeerId = event.from;
    this.setupPeer(false, event.data as SignalPayload);
  }

  private setupPeer(initiator: boolean, initialSignal?: SignalPayload): void {
    if (this.closed) return;
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: this.iceServers },
    });
    this.peer = peer;

    peer.on('signal', (data) => {
      const target = this.remotePeerId;
      if (!target) return;
      void this.signalClient
        .sendSignal(target, data as unknown as SignalData)
        .catch((err) => {
          console.error('[rtc] sendSignal failed', err);
        });
    });

    peer.on('connect', () => {
      this.setStatus('open');
    });

    peer.on('data', (data: unknown) => {
      // simple-peer surfaces strings as Uint8Array; sniff for JSON text
      // by attempting decode, fall back to binary delivery.
      const ab = toArrayBuffer(data);
      if (!ab) return;
      const text = tryDecodeJsonText(ab);
      if (text !== null) {
        try {
          const msg = JSON.parse(text) as ControlMessage;
          this.opts.onControlMessage?.(msg);
          return;
        } catch {
          // not JSON — fall through to binary
        }
      }
      this.opts.onBinaryMessage?.(ab);
    });

    peer.on('close', () => {
      if (this.peer === peer) this.peer = null;
      if (!this.closed) this.setStatus('closed');
    });

    peer.on('error', (err: Error) => {
      if (this.closed) return;
      this.setStatus('error', `peer:${err.message}`);
    });

    if (initialSignal) {
      try {
        peer.signal(initialSignal);
      } catch (err) {
        console.error('[rtc] peer.signal (initial) failed', err);
      }
    }
  }

  private setStatus(status: RtcStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status, detail);
  }
}

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(
      new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength),
    );
    return out;
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).buffer as ArrayBuffer;
  }
  return null;
}

// Heuristic: control messages are JSON objects, so the first byte is
// '{'. PCM16 audio frames almost never start with 0x7B, so this is a
// reliable split.
function tryDecodeJsonText(ab: ArrayBuffer): string | null {
  if (ab.byteLength === 0) return null;
  const first = new Uint8Array(ab, 0, 1)[0];
  if (first !== 0x7b /* { */) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(ab);
  } catch {
    return null;
  }
}

// Helper to read the host peer ID from URL query parameter
export function getHostPeerIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('host') || null;
}
