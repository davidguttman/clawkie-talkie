// Daemon-side rendezvous host. The daemon advertises a stable
// rendezvous/control room named after `opts.peerId` (`host=H` in the
// public URL). Browsers join that room, send a single
// `rendezvous.join` control message with the OpenClaw `sessionId` and
// receive back a
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
  validateRendezvousDelivery,
  type PhoneToDaemon,
} from './protocol.js';
import { SignalClient, type SignalData } from './signal.js';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind.js';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;
import { DEFAULT_SIGNAL_SERVER } from './signalServer.js';
import { makeVoiceRoomId } from './voiceRoom.js';
import { VoiceSession } from './voiceSession.js';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

const RENDEZVOUS_TIMEOUT_MS = 12_000;

export interface DaemonPeerOptions {
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
  initiator: boolean;
  acceptedOffer: boolean;
  acceptedAnswer: boolean;
}

export class DaemonPeer {
  private readonly signalClient: SignalClient;
  private readonly iceServers: RTCIceServer[];
  private readonly signalServer: string;
  private readonly maxVoiceSessions: number;
  private readyAnnounced = false;

  private rendezvousPeers = new Map<string, RendezvousPeer>();
  private voiceSessions = new Map<string, VoiceSession>();
  private pendingCandidates = new Map<string, SignalPayload[]>();

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
      const payload = event.data as SignalPayload;
      const existing = this.rendezvousPeers.get(event.from);
      const livePeer = !!existing && !existing.peer.destroyed;
      const kind = classifySignal(payload);
      const action = decideIncomingSignal({ hasLivePeer: livePeer, kind });

      if (action === 'forward') {
        const rp = existing!;
        const decision = decideForwardToLivePeer(
          {
            initiator: rp.initiator,
            acceptedOffer: rp.acceptedOffer,
            acceptedAnswer: rp.acceptedAnswer,
          },
          kind,
        );
        if (decision !== 'forward') {
          console.error(`[peer] rendezvous dropping ${kind} for ${event.from}: ${decision}`);
          return;
        }
        try {
          rp.peer.signal(payload);
          if (kind === 'offer') rp.acceptedOffer = true;
          if (kind === 'answer') rp.acceptedAnswer = true;
        } catch (err) {
          console.error(`[peer] rendezvous peer.signal failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }

      if (action === 'create-non-initiator') {
        const buffered = this.pendingCandidates.get(event.from) ?? [];
        this.pendingCandidates.delete(event.from);
        this.acceptRendezvous(event.from, false, payload);
        const rp = this.rendezvousPeers.get(event.from);
        if (rp) {
          for (const cand of buffered) {
            try { rp.peer.signal(cand); } catch (err) {
              console.error(`[peer] rendezvous replay candidate failed: ${err instanceof Error ? err.message : err}`);
            }
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

      console.error(`[peer] ignoring ${kind} signal from ${event.from} with no live rendezvous peer`);
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

    const rp: RendezvousPeer = {
      peer,
      remoteId,
      timeout,
      connected: false,
      initiator,
      acceptedOffer: false,
      acceptedAnswer: false,
    };
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
        const initialKind = classifySignal(initialSignal);
        if (initialKind === 'offer') rp.acceptedOffer = true;
        if (initialKind === 'answer') rp.acceptedAnswer = true;
      } catch (err) {
        console.error(`[peer] rendezvous initial signal failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private dropRendezvous(remoteId: string): void {
    this.pendingCandidates.delete(remoteId);
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
    const sessionKey = (msg.sessionKey ?? '').trim();
    const channel = (msg.channel ?? '').trim();
    const target = (msg.target ?? '').trim();
    const accountId = (msg.accountId ?? '').trim();
    const deliveryValidation = validateRendezvousDelivery(msg.delivery);
    if (!sessionId) {
      this.sendRendezvous(rp, daemonToPhone.rendezvousError('missing_session'));
      return;
    }
    if (!deliveryValidation.ok) {
      this.sendRendezvous(rp, daemonToPhone.rendezvousError(deliveryValidation.message));
      return;
    }
    const delivery = deliveryValidation.delivery;

    if (this.voiceSessions.size >= this.maxVoiceSessions) {
      const existing = this.voiceSessions.get(makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId }));
      if (!existing) {
        this.sendRendezvous(rp, daemonToPhone.rendezvousError('too_many_voice_sessions'));
        return;
      }
    }

    const roomId = makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId });

    const existingSession = this.voiceSessions.get(roomId);
    if (!existingSession) {
      const session = new VoiceSession({
        sttLanguage: this.opts.sttLanguage,
        signalServer: this.signalServer,
        iceServers: this.iceServers,
        hostPeerId: this.opts.peerId,
        roomId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(channel ? { channel } : {}),
        ...(target ? { target } : {}),
        ...(accountId ? { accountId } : {}),
        delivery,
        ...(msg.settings ? { voiceSettings: msg.settings } : {}),
        onClose: (id) => {
          this.voiceSessions.delete(id);
        },
      });
      this.voiceSessions.set(roomId, session);
    } else {
      // A returning phone may have changed its TTS/STT preference between
      // joins. Omitted settings on an existing session mean local Default,
      // so clear any explicit hints retained by the daemon.
      existingSession.applyVoiceSettings(msg.settings ?? {});
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
