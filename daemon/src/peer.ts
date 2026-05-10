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
  daemonHandshakeResponse,
  daemonToPhone,
  validateRendezvousDelivery,
  type PhoneToDaemon,
  type RecentSessionsSnapshot,
} from './protocol.js';
import { SignalClient, type SignalData } from './signal.js';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind.js';

import { createEmptyRecentSessionsSnapshot, defaultRecentSessionsCache } from './recentSessions.js';
import { DEFAULT_SIGNAL_SERVER } from './signalServer.js';
import { makeVoiceRoomId } from './voiceRoom.js';
import { VoiceSession } from './voiceSession.js';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

const RENDEZVOUS_TIMEOUT_MS = 12_000;
const RECENT_SESSIONS_SUBSCRIPTION_INTERVAL_MS = 60_000;
// Conservative resource guard for simultaneous WebRTC/STT/TTS lanes;
// not a mathematically derived capacity limit.
const DEFAULT_MAX_VOICE_SESSIONS = 8;

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
  recentSessionsProvider?: () => Promise<RecentSessionsSnapshot>;
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
  recentSessionsInterval: NodeJS.Timeout | null;
  protocolUnsupported: boolean;
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
    this.maxVoiceSessions = opts.maxVoiceSessions ?? DEFAULT_MAX_VOICE_SESSIONS;

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
      recentSessionsInterval: null,
      protocolUnsupported: false,
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
    if (rp.recentSessionsInterval) clearInterval(rp.recentSessionsInterval);
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
    if (rp.protocolUnsupported) return;
    if (msg.t === 'client.hello') {
      const response = daemonHandshakeResponse(msg);
      this.sendRendezvous(rp, response);
      if (response.t === 'daemon.unsupported') rp.protocolUnsupported = true;
      return;
    }
    if (msg.t === 'sessions.list.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousRecentSessions(rp, 'list');
      return;
    }
    if (msg.t === 'sessions.catalog.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousRecentSessions(rp, 'catalog');
      return;
    }
    if (msg.t === 'sessions.list.subscribe') {
      this.keepRendezvousOpenForDashboard(rp);
      this.startRendezvousRecentSessionsSubscription(rp);
      void this.sendRendezvousRecentSessions(rp, 'list');
      return;
    }
    if (msg.t === 'sessions.list.unsubscribe') {
      this.stopRendezvousRecentSessionsSubscription(rp);
      return;
    }
    if (msg.t !== 'rendezvous.join') {
      // The rendezvous lane accepts host-scoped recent-session discovery
      // plus a single join. Any other control message is a sign the
      // browser is targeting the wrong room.
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

    const roomId = makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId });

    if (!this.ensureVoiceSessionCapacityFor(roomId)) {
      this.sendRendezvous(rp, daemonToPhone.rendezvousError('too_many_voice_sessions'));
      return;
    }

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
        ...(this.opts.recentSessionsProvider ? { recentSessionsProvider: this.opts.recentSessionsProvider } : {}),
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

  private ensureVoiceSessionCapacityFor(roomId: string): boolean {
    if (this.voiceSessions.has(roomId)) return true;
    if (this.voiceSessions.size < this.maxVoiceSessions) return true;

    let oldestRoomId: string | null = null;
    let oldestSession: VoiceSession | null = null;
    for (const [candidateRoomId, session] of this.voiceSessions) {
      if (!session.canEvictForVoiceSessionLimit) continue;
      if (!oldestSession || session.lastUsedAtMs < oldestSession.lastUsedAtMs) {
        oldestRoomId = candidateRoomId;
        oldestSession = session;
      }
    }
    if (!oldestRoomId || !oldestSession) return false;

    console.error(`[peer] evicting idle voice session room=${oldestRoomId} to admit room=${roomId}`);
    this.voiceSessions.delete(oldestRoomId);
    try {
      oldestSession.close();
    } catch (err) {
      console.error(`[peer] evicted voice session close failed: ${err instanceof Error ? err.message : err}`);
    }
    return true;
  }

  private keepRendezvousOpenForDashboard(rp: RendezvousPeer): void {
    // Host dashboards intentionally remain on the rendezvous lane while the
    // user chooses a session, so the short join timeout no longer applies.
    clearTimeout(rp.timeout);
  }

  private startRendezvousRecentSessionsSubscription(rp: RendezvousPeer): void {
    if (rp.recentSessionsInterval) return;
    rp.recentSessionsInterval = setInterval(() => {
      void this.sendRendezvousRecentSessions(rp, 'list');
    }, RECENT_SESSIONS_SUBSCRIPTION_INTERVAL_MS);
    rp.recentSessionsInterval.unref?.();
  }

  private stopRendezvousRecentSessionsSubscription(rp: RendezvousPeer): void {
    if (!rp.recentSessionsInterval) return;
    clearInterval(rp.recentSessionsInterval);
    rp.recentSessionsInterval = null;
  }

  private async sendRendezvousRecentSessions(rp: RendezvousPeer, format: 'list' | 'catalog'): Promise<void> {
    const toMessage = format === 'catalog' ? daemonToPhone.sessionsCatalog : daemonToPhone.sessionsList;
    try {
      const loadSessions = this.opts.recentSessionsProvider ?? (() => defaultRecentSessionsCache.get());
      this.sendRendezvous(rp, toMessage(await loadSessions()));
    } catch {
      this.sendRendezvous(rp, toMessage(createEmptyRecentSessionsSnapshot()));
    }
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
