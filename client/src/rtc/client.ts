// Browser WebRTC client. Uses a rambly-style signaling server (SSE
// subscribe + HTTP POST signal) to discover the daemon, then connects
// over WebRTC via simple-peer.
//
// The phone joins a "room" named after the daemon's UUID (passed as the
// `host=<uuid>` URL param/hash value). The daemon is already in that room; when
// the phone announces itself, the daemon initiates a simple-peer
// connection. The DataChannel carries JSON control frames + binary
// PCM16 audio.

import SimplePeer from 'simple-peer';
import { SignalClient, type SignalData, type SignalEvent } from './signal';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;

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
  onRemoteStream?: (stream: MediaStream) => void;
}

const DEFAULT_SIGNAL_SERVER =
  typeof import.meta.env.VITE_SIGNAL_SERVER === 'string' && import.meta.env.VITE_SIGNAL_SERVER.length > 0
    ? import.meta.env.VITE_SIGNAL_SERVER
    : 'https://api.rambly.app';

const HOSTED_DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
  { urls: 'turn:api.rambly.app:3478?transport=tcp', username: 'rambly', credential: 'rambly' },
];

export const DEFAULT_ICE_SERVERS: RTCIceServer[] =
  parseClientIceServersJson(import.meta.env.VITE_ICE_SERVERS_JSON) ?? HOSTED_DEFAULT_ICE_SERVERS;

export function parseClientIceServersJson(
  raw: unknown,
  warn: (message: string) => void = console.warn,
): RTCIceServer[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return normalizeIceServers(JSON.parse(raw));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`Invalid VITE_ICE_SERVERS_JSON; using hosted ICE defaults (${detail})`);
    return null;
  }
}

function normalizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) throw new Error('expected JSON array of RTCIceServer objects');
  return value.map((entry, index) => normalizeIceServer(entry, index));
}

function normalizeIceServer(value: unknown, index: number): RTCIceServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`entry ${index} is not an object`);
  }
  const source = value as Record<string, unknown>;
  const urls = normalizeUrls(source.urls, index);
  const out: RTCIceServer = { urls };
  if (source.username !== undefined) {
    if (typeof source.username !== 'string') throw new Error(`entry ${index}.username is not a string`);
    out.username = source.username;
  }
  if (source.credential !== undefined) {
    if (typeof source.credential !== 'string') throw new Error(`entry ${index}.credential is not a string`);
    out.credential = source.credential;
  }
  return out;
}

function normalizeUrls(value: unknown, index: number): string | string[] {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())) {
    return value;
  }
  throw new Error(`entry ${index}.urls must be a non-empty string or string array`);
}

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
  private peerInitiator = false;
  private acceptedOffer = false;
  private acceptedAnswer = false;
  private remotePeerId: string | null = null;
  private status: RtcStatus = 'idle';
  private closed = false;
  private readonly iceServers: RTCIceServer[];
  private readonly pendingCandidates = new Map<string, SignalPayload[]>();

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
    const payload = event.data as SignalPayload;
    const livePeer = this.peer && !this.peer.destroyed
      ? this.remotePeerId === event.from
      : false;
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
        console.warn(`[rtc] dropping ${kind} from ${event.from}: ${decision}`);
        return;
      }
      try {
        this.peer!.signal(payload);
        if (kind === 'offer') this.acceptedOffer = true;
        if (kind === 'answer') this.acceptedAnswer = true;
      } catch (err) {
        console.error('[rtc] peer.signal failed', err);
      }
      return;
    }

    if (action === 'create-non-initiator') {
      this.remotePeerId = event.from;
      const buffered = this.pendingCandidates.get(event.from) ?? [];
      this.pendingCandidates.delete(event.from);
      this.setupPeer(false, payload);
      for (const cand of buffered) {
        try {
          this.peer?.signal(cand);
        } catch (err) {
          console.error('[rtc] replay candidate failed', err);
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

    // 'ignore' — stale answer / renegotiate / unknown without a peer
    console.warn(`[rtc] ignoring ${kind} signal from ${event.from} with no live peer`);
  }

  private setupPeer(initiator: boolean, initialSignal?: SignalPayload): void {
    if (this.closed) return;
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: this.iceServers },
    });
    this.peer = peer;
    this.peerInitiator = initiator;
    this.acceptedOffer = false;
    this.acceptedAnswer = false;

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

    peer.on('stream', (stream: MediaStream) => {
      try {
        this.opts.onRemoteStream?.(stream);
      } catch (err) {
        console.error('[rtc] onRemoteStream handler threw', err);
      }
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
        const initialKind = classifySignal(initialSignal);
        if (initialKind === 'offer') this.acceptedOffer = true;
        if (initialKind === 'answer') this.acceptedAnswer = true;
      } catch (err) {
        console.error('[rtc] peer.signal (initial) failed', err);
      }
    }
  }

  private setStatus(status: RtcStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
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
