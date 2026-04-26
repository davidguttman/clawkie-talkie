// Daemon-side rendezvous host. The daemon advertises a stable
// rendezvous/control room named after `opts.peerId` (`host=H` in the
// public URL). Browsers join that room, send a single
// `rendezvous.join` control message with the OpenClaw `sessionId` and
// generic delivery `{channel,target}`, and receive back a
// `rendezvous.accept` containing a deterministic per-session
// `roomId = makeVoiceRoomId({ host, session })`. The browser then
// re-connects to the voice room. Actual voice/STT/TTS/OpenClaw turns
// happen inside `VoiceSession`, one per active room.
//
// State here is intentionally narrow: a rendezvous SignalClient, a
// short-lived peer per joining browser (closed after accept), and a
// `roomId -> VoiceSession` map. There is no pre-created link table,
// no random join-id store, no TTL, no claim/revocation.

import wrtc from '@roamhq/wrtc';
import SimplePeer from 'simple-peer';
import {
  daemonToPhone,
  type DeliveryTarget,
  type PhoneToDaemon,
} from './protocol.js';
import { SignalClient, type SignalData } from './signal.js';
import { makeVoiceRoomId } from './voiceRoom.js';
import { VoiceSession } from './voiceSession.js';

const DEFAULT_SIGNAL_SERVER =
  process.env.SIGNAL_SERVER?.trim() || 'https://api.rambly.app';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

const RENDEZVOUS_TIMEOUT_MS = 12_000;

export interface DaemonPeerOptions {
  apiKey: string;
  sttLanguage?: string;
  peerId: string;
  // Legacy CLI fallback when the daemon is started with
  // --session-id/--thread-id and no rendezvous join arrives. Used only
  // by the dev compat path in `index.ts`.
  sessionId?: string;
  threadId?: string;
  signalServer?: string;
  iceServers?: RTCIceServer[];
  maxVoiceSessions?: number;
  onReady: (peerId: string) => void;
  onFatalError?: (err: Error) => void;
}

type SignalPayload = Parameters<SimplePeer.Instance['signal']>[0];

interface RendezvousPeer {
  peer: SimplePeer.Instance;
  remoteId: string;
  timeout: NodeJS.Timeout;
  connected: boolean;
}

export class DaemonPeer {
  private readonly signalClient: SignalClient;
  private readonly iceServers: RTCIceServer[];
  private readonly signalServer: string;
  private readonly maxVoiceSessions: number;
  private readyAnnounced = false;

  private rendezvousPeers = new Map<string, RendezvousPeer>();
  private voiceSessions = new Map<string, VoiceSession>();

  constructor(private readonly opts: DaemonPeerOptions) {
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;
    this.signalServer = opts.signalServer ?? DEFAULT_SIGNAL_SERVER;
    this.maxVoiceSessions = opts.maxVoiceSessions ?? 8;

    this.signalClient = new SignalClient({
      signalServer: this.signalServer,
      peerId: opts.peerId,
      roomName: opts.peerId,
    });

    this.signalClient.on('open', () => {
      console.error(`[peer] subscribed to rendezvous room as ${opts.peerId}`);
      if (!this.readyAnnounced) {
        this.readyAnnounced = true;
        opts.onReady(opts.peerId);
      }
    });

    this.signalClient.on('error', (err) => {
      console.error(`[peer] rendezvous signal error: ${err.message}`);
      if (err.message.includes('404') || err.message.includes('400')) {
        opts.onFatalError?.(err);
      }
    });

    this.signalClient.on('announce', ({ peerId }) => {
      this.acceptRendezvous(peerId, true);
    });

    this.signalClient.on('signal', (event) => {
      const existing = this.rendezvousPeers.get(event.from);
      if (existing && !existing.peer.destroyed) {
        try {
          existing.peer.signal(event.data as SignalPayload);
        } catch (err) {
          console.error(`[peer] rendezvous peer.signal failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
      this.acceptRendezvous(event.from, false, event.data as SignalPayload);
    });

    this.signalClient.subscribe();
  }

  close(): void {
    for (const rp of this.rendezvousPeers.values()) {
      clearTimeout(rp.timeout);
      try { rp.peer.destroy(); } catch { /* ignore */ }
    }
    this.rendezvousPeers.clear();

    for (const session of this.voiceSessions.values()) {
      try { session.close(); } catch { /* ignore */ }
    }
    this.voiceSessions.clear();

    try { this.signalClient.close(); } catch { /* ignore */ }
  }

  private acceptRendezvous(remoteId: string, initiator: boolean, initialSignal?: SignalPayload): void {
    const existing = this.rendezvousPeers.get(remoteId);
    if (existing && !existing.peer.destroyed) {
      if (initialSignal) {
        try { existing.peer.signal(initialSignal); } catch { /* ignore */ }
      }
      return;
    }

    console.error(`[peer] rendezvous opening with phone=${remoteId} initiator=${initiator}`);

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: wrtc as unknown as SimplePeer.Options['wrtc'],
      config: { iceServers: this.iceServers },
    });

    const timeout = setTimeout(() => {
      const rp = this.rendezvousPeers.get(remoteId);
      if (!rp || rp.peer !== peer) return;
      console.error(`[peer] rendezvous timed out with phone=${remoteId}`);
      this.dropRendezvous(remoteId);
    }, RENDEZVOUS_TIMEOUT_MS);
    timeout.unref?.();

    const rp: RendezvousPeer = { peer, remoteId, timeout, connected: false };
    this.rendezvousPeers.set(remoteId, rp);

    peer.on('signal', (data) => {
      void this.signalClient
        .sendSignal(remoteId, data as unknown as SignalData)
        .catch((err) => {
          console.error(`[peer] rendezvous sendSignal failed: ${err instanceof Error ? err.message : err}`);
        });
    });

    peer.on('connect', () => {
      rp.connected = true;
      console.error(`[peer] rendezvous data channel connected for ${remoteId}`);
    });

    peer.on('data', (data: unknown) => {
      this.handleRendezvousData(rp, data);
    });

    peer.on('close', () => {
      this.dropRendezvous(remoteId);
    });

    peer.on('error', (err) => {
      console.error(`[peer] rendezvous error for ${remoteId}: ${err.message}`);
      this.dropRendezvous(remoteId);
    });

    if (initialSignal) {
      try {
        peer.signal(initialSignal);
      } catch (err) {
        console.error(`[peer] rendezvous initial signal failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private dropRendezvous(remoteId: string): void {
    const rp = this.rendezvousPeers.get(remoteId);
    if (!rp) return;
    clearTimeout(rp.timeout);
    try { rp.peer.destroy(); } catch { /* ignore */ }
    this.rendezvousPeers.delete(remoteId);
  }

  private handleRendezvousData(rp: RendezvousPeer, data: unknown): void {
    const text = decodeJsonText(data);
    if (text === null) return;
    let msg: PhoneToDaemon;
    try {
      msg = JSON.parse(text) as PhoneToDaemon;
    } catch {
      return;
    }
    if (msg.t !== 'rendezvous.join') {
      // The rendezvous lane only accepts a join — any other control
      // message is a sign the browser is targeting the wrong room.
      this.sendRendezvous(rp, daemonToPhone.rendezvousError('unexpected_message'));
      return;
    }
    const sessionId = (msg.sessionId ?? '').trim();
    const delivery: DeliveryTarget = {
      channel: (msg.delivery?.channel ?? '').trim(),
      target: (msg.delivery?.target ?? '').trim(),
    };
    if (!sessionId || !delivery.channel || !delivery.target) {
      this.sendRendezvous(rp, daemonToPhone.rendezvousError('missing_session_or_delivery'));
      return;
    }

    if (this.voiceSessions.size >= this.maxVoiceSessions) {
      const existing = this.voiceSessions.get(makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId }));
      if (!existing) {
        this.sendRendezvous(rp, daemonToPhone.rendezvousError('too_many_voice_sessions'));
        return;
      }
    }

    const roomId = makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId });

    if (!this.voiceSessions.has(roomId)) {
      const session = new VoiceSession({
        apiKey: this.opts.apiKey,
        sttLanguage: this.opts.sttLanguage,
        signalServer: this.signalServer,
        iceServers: this.iceServers,
        hostPeerId: this.opts.peerId,
        roomId,
        sessionId,
        delivery,
        onClose: (id) => {
          this.voiceSessions.delete(id);
        },
      });
      this.voiceSessions.set(roomId, session);
    }

    this.sendRendezvous(rp, daemonToPhone.rendezvousAccept(roomId));

    // Drop the rendezvous lane after accept — the browser will open a
    // fresh peer connection to `roomId` for actual voice traffic.
    setTimeout(() => this.dropRendezvous(rp.remoteId), 250).unref?.();
  }

  private sendRendezvous(rp: RendezvousPeer, msg: unknown): void {
    if (rp.peer.destroyed) return;
    try {
      rp.peer.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[peer] rendezvous send failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Test/manager hook for tracking active rooms.
  get activeRoomIds(): string[] {
    return Array.from(this.voiceSessions.keys());
  }
}

function decodeJsonText(data: unknown): string | null {
  let bytes: Uint8Array | null = null;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (typeof data === 'string') {
    return data;
  }
  if (!bytes || bytes.length === 0) return null;
  if (bytes[0] !== 0x7b) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
