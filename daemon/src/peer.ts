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

import { wrtc } from './wrtc-patch.js';
import SimplePeer from 'simple-peer';
import {
  daemonHandshakeResponse,
  daemonToPhone,
  validateRendezvousDelivery,
  type DaemonToPhone,
  type NewSessionDestinationOption,
  type NewSessionDestinationsCatalog,
  type PhoneToDaemon,
  type RecentSessionsSnapshot,
  type TtsCatalog,
  type SttCatalog,
} from './protocol.js';
import { SignalClient, type SignalData } from './signal.js';
import { classifySignal, decideForwardToLivePeer, decideIncomingSignal } from './signalKind.js';

import { createEmptyRecentSessionsSnapshot, defaultRecentSessionsCache } from './recentSessions.js';
import {
  buildNewSessionCreateResponse,
  createWebchatNewSession,
  createWebchatOnlyNewSessionDestinationsCatalog,
  getNewSessionDestinationsWithOpenClaw,
  type NewSessionCreateRequestLike,
} from './newSession.js';
import { createEmptyTtsCatalog, defaultTtsCatalogCache } from './ttsCatalog.js';
import type { PushAudioRequest, PushAudioResult, PushSpeechRequest } from './pushAudio.js';
import { createEmptySttCatalog, defaultSttCatalogCache } from './sttCatalog.js';
import { DEFAULT_SIGNAL_SERVER } from './signalServer.js';
import { makeVoiceRoomId } from './voiceRoom.js';
import { VoiceSession } from './voiceSession.js';

const MAX_BUFFERED_CANDIDATES_PER_PEER = 32;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:api.rambly.app:3478', username: 'rambly', credential: 'rambly' },
];

// Mobile browsers can take noticeably longer to complete the initial
// answer/ICE exchange, so keep the rendezvous peer alive a bit longer
// before giving up on the join.
const RENDEZVOUS_TIMEOUT_MS = 60_000;
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
  ttsCatalogProvider?: () => Promise<TtsCatalog>;
  sttCatalogProvider?: () => Promise<SttCatalog>;
  newSessionDestinationsProvider?: () => Promise<NewSessionDestinationsCatalog>;
  newSessionDiscordDestinationsProvider?: () => Promise<NewSessionDestinationOption[]>;
  newSessionSlackDestinationsProvider?: () => Promise<NewSessionDestinationOption[]>;
  newSessionCreateResponder?: (msg: NewSessionCreateRequestLike) => Promise<DaemonToPhone>;
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
  joined: boolean;
  joinFallback: NodeJS.Timeout | null;
  channelPoll: NodeJS.Timeout | null;
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

  /**
   * Push unsolicited audio to the voice room speaking for a session.
   * Queues while the room is busy; never interrupts. See pushAudio.ts.
   */
  pushAudioFile(sessionId: string, req: PushAudioRequest): Promise<PushAudioResult> {
    const wanted = sessionId.trim();
    for (const session of this.voiceSessions.values()) {
      if (session.sessionId === wanted) return session.pushAudioFile(req);
    }
    return Promise.resolve({
      ok: false,
      error: 'no_client',
      detail: `no active voice room for session ${wanted}`,
    });
  }

  /** Speak unsolicited text to the voice room for a session (notification). */
  pushSpeech(sessionId: string, req: PushSpeechRequest): Promise<PushAudioResult> {
    const wanted = sessionId.trim();
    for (const session of this.voiceSessions.values()) {
      if (session.sessionId === wanted) return session.pushSpeech(req);
    }
    return Promise.resolve({
      ok: false,
      error: 'no_client',
      detail: `no active voice room for session ${wanted}`,
    });
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
      joined: false,
      joinFallback: null,
      channelPoll: null,
    };
    this.rendezvousPeers.set(remoteId, rp);

    peer.on('signal', (data) => {
      // Filter candidates to reduce ESP32 network stack load.
      // The ESP32 has limited LwIP sockets — TCP and IPv6 candidates
      // exhaust sockets and starve the DTLS handshake.
      const candidateStr = (data as { candidate?: { candidate?: string } })?.candidate?.candidate;
      if (candidateStr) {
        // Drop TCP candidates — ESP32 has limited sockets
        if (candidateStr.includes('tcptype')) return;
        // Drop localhost
        if (candidateStr.includes('127.0.0.1')) return;
        // Drop IPv6 candidates (addresses with multiple colons)
        // IPv4 candidates contain dots (192.168.x.x), IPv6 don't
        const parts = candidateStr.split(' ');
        const ip = parts[4]; // candidate:ID COMPONENT PROTO PRIORITY IP PORT ...
        if (ip && ip.includes(':') && !ip.includes('.')) return;
      }
      void this.signalClient
        .sendSignal(remoteId, data as unknown as SignalData)
        .catch((err) => {
          console.error(`[peer] rendezvous sendSignal failed: ${err instanceof Error ? err.message : err}`);
        });
    });

    // Auto-join fallback: fire 2s after peer creation, NOT waiting
    // for connect/data channel. Both daemon.hello and rendezvous.accept are
    // sent via signaling server (SSE) so they reach the ESP32 even when
    // wrtc's SCTP data channel never opens. Web client cancels this timer
    // by sending rendezvous.join before it fires.
    rp.joinFallback = setTimeout(() => {
      if (rp.joined) return;
      console.error(`[peer] rendezvous auto-creating session for ${remoteId} (no rendezvous.join received)`);
      const session = createWebchatNewSession({ agent: 'main' });
      const roomId = makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId: session.sessionId });
      if (!this.ensureVoiceSessionCapacityFor(roomId)) {
        this.sendRendezvous(rp, daemonToPhone.rendezvousError('too_many_voice_sessions'));
        return;
      }
      const voiceSession = new VoiceSession({
        sttLanguage: this.opts.sttLanguage,
        signalServer: this.signalServer,
        iceServers: this.iceServers,
        hostPeerId: this.opts.peerId,
        roomId,
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        channel: session.channel,
        delivery: undefined,
        ...(this.opts.recentSessionsProvider ? { recentSessionsProvider: this.opts.recentSessionsProvider } : {}),
        ...(this.opts.ttsCatalogProvider ? { ttsCatalogProvider: this.opts.ttsCatalogProvider } : {}),
        ...(this.opts.sttCatalogProvider ? { sttCatalogProvider: this.opts.sttCatalogProvider } : {}),
        ...(this.opts.newSessionDestinationsProvider ? { newSessionDestinationsProvider: this.opts.newSessionDestinationsProvider } : {}),
        ...(this.opts.newSessionDiscordDestinationsProvider ? { newSessionDiscordDestinationsProvider: this.opts.newSessionDiscordDestinationsProvider } : {}),
        ...(this.opts.newSessionSlackDestinationsProvider ? { newSessionSlackDestinationsProvider: this.opts.newSessionSlackDestinationsProvider } : {}),
        ...(this.opts.newSessionCreateResponder ? { newSessionCreateResponder: this.opts.newSessionCreateResponder } : {}),
        onClose: (id) => { this.voiceSessions.delete(id); },
      });
      this.voiceSessions.set(roomId, voiceSession);
      rp.joined = true;
      // Send daemon.hello via signaling so ESP32 gets it even without data channel
      this.sendRendezvousViaSignal(rp, daemonToPhone.daemonHello());
      // Send rendezvous.accept via signaling
      this.sendRendezvousViaSignal(rp, daemonToPhone.rendezvousAccept(roomId));
      console.error(`[peer] rendezvous auto-created session=${session.sessionId} room=${roomId} for ${remoteId}`);
      setTimeout(() => this.dropRendezvous(rp.remoteId), 5_000).unref?.();
    }, 2_000).unref?.();

    // Poll for data channel readiness (for web client that uses data channel)
    rp.channelPoll = setInterval(() => {
      if (rp.joined) { if (rp.channelPoll) clearInterval(rp.channelPoll); return; }
      const p = peer as unknown as { _channel?: { readyState: string } };
      const ch = p._channel;
      if (ch && ch.readyState === 'open' && !rp.connected) {
        rp.connected = true;
        console.error(`[peer] rendezvous data channel open (poll) for ${remoteId}`);
      }
    }, 500).unref?.();


    peer.on('connect', () => {
      rp.connected = true;
      console.error(`[peer] rendezvous data channel connected for ${remoteId}`);
      // Proactively send daemon.hello without waiting for client.hello.
      // This handles clients (e.g. ESP32) that can receive data but whose
      // SCTP data-channel sends don't surface in wrtc's `data` event.
      const hello = daemonToPhone.daemonHello();
      try {
        const buf = Buffer.from(JSON.stringify(hello), 'utf8');
        peer.send(buf);
        console.error(`[peer] rendezvous proactive daemon.hello sent to ${remoteId}`);
      } catch (err) {
        console.error(`[peer] rendezvous proactive daemon.hello send failed: ${err instanceof Error ? err.message : err}`);
      }

      // Fallback: if no rendezvous.join arrives within 3s (web client
      // sends it immediately), auto-create a webchat session for hardware
      // devices that can send data daemon→device but not device→daemon.
      // Web client is unaffected — its rendezvous.join cancels this timer.
      rp.joinFallback = setTimeout(() => {
        if (rp.joined) return;
        console.error(`[peer] rendezvous auto-creating session for ${remoteId} (no rendezvous.join received)`);
        const session = createWebchatNewSession({ agent: 'main' });
        const roomId = makeVoiceRoomId({ hostPeerId: this.opts.peerId, sessionId: session.sessionId });
        if (!this.ensureVoiceSessionCapacityFor(roomId)) {
          this.sendRendezvous(rp, daemonToPhone.rendezvousError('too_many_voice_sessions'));
          return;
        }
        const voiceSession = new VoiceSession({
          sttLanguage: this.opts.sttLanguage,
          signalServer: this.signalServer,
          iceServers: this.iceServers,
          hostPeerId: this.opts.peerId,
          roomId,
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          channel: session.channel,
          delivery: undefined,
          ...(this.opts.recentSessionsProvider ? { recentSessionsProvider: this.opts.recentSessionsProvider } : {}),
          ...(this.opts.ttsCatalogProvider ? { ttsCatalogProvider: this.opts.ttsCatalogProvider } : {}),
          ...(this.opts.sttCatalogProvider ? { sttCatalogProvider: this.opts.sttCatalogProvider } : {}),
          ...(this.opts.newSessionDestinationsProvider ? { newSessionDestinationsProvider: this.opts.newSessionDestinationsProvider } : {}),
          ...(this.opts.newSessionDiscordDestinationsProvider ? { newSessionDiscordDestinationsProvider: this.opts.newSessionDiscordDestinationsProvider } : {}),
          ...(this.opts.newSessionSlackDestinationsProvider ? { newSessionSlackDestinationsProvider: this.opts.newSessionSlackDestinationsProvider } : {}),
          ...(this.opts.newSessionCreateResponder ? { newSessionCreateResponder: this.opts.newSessionCreateResponder } : {}),
          onClose: (id) => { this.voiceSessions.delete(id); },
        });
        this.voiceSessions.set(roomId, voiceSession);
        rp.joined = true;
        this.sendRendezvous(rp, daemonToPhone.rendezvousAccept(roomId));
        console.error(`[peer] rendezvous auto-created session=${session.sessionId} room=${roomId} for ${remoteId}`);
        // Keep the rendezvous lane alive longer for hardware devices —
        // the ESP32 needs time to receive the accept message before
        // the peer connection is torn down. Web client path drops after 250ms.
        setTimeout(() => this.dropRendezvous(rp.remoteId), 5_000).unref?.();
      }, 1_500).unref?.();
    });

    peer.on('data', (data: unknown) => {
      console.error(`[peer] rendezvous DATA EVENT fired for ${remoteId} (${typeof data} len=${Array.isArray(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : data instanceof Uint8Array ? data.length : typeof data === 'string' ? data.length : '?'})`);
      this.handleRendezvousData(rp, data);
    });

    // Log raw channel events for debugging SCTP interop
    const rawChannel = (peer as unknown as { channel?: { onopen?: ((e: unknown) => void) | null; onmessage?: ((e: unknown) => void) | null; readyState?: string; label?: string } }).channel;
    if (rawChannel) {
      console.error(`[peer] rendezvous raw channel label=${rawChannel.label} readyState=${rawChannel.readyState}`);
      const origOnMessage = rawChannel.onmessage;
      rawChannel.onmessage = (e: unknown) => {
        console.error(`[peer] rendezvous raw onmessage for ${remoteId}: ${typeof e}`);
        if (origOnMessage) origOnMessage.call(rawChannel, e);
      };
    } else {
      console.error(`[peer] rendezvous no raw channel available for ${remoteId}`);
    }

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
    if (rp.joinFallback) { clearTimeout(rp.joinFallback); rp.joinFallback = null; }
    if (rp.channelPoll) { clearInterval(rp.channelPoll); rp.channelPoll = null; }
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
    if (msg.t === 'tts.catalog.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousTtsCatalog(rp);
      return;
    }
    if (msg.t === 'stt.catalog.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousSttCatalog(rp);
      return;
    }
    if (msg.t === 'sessions.destinations.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousNewSessionDestinations(rp);
      return;
    }
    if (msg.t === 'sessions.create.request') {
      this.keepRendezvousOpenForDashboard(rp);
      void this.sendRendezvousNewSessionCreateResponse(rp, msg);
      return;
    }
    if (msg.t !== 'rendezvous.join') {
      // The rendezvous lane accepts host-scoped recent-session discovery
      // plus a single join. Any other control message is a sign the
      // browser is targeting the wrong room.
      this.sendRendezvous(rp, daemonToPhone.rendezvousError('unexpected_message'));
      return;
    }
    // Cancel the auto-join fallback — the web client sent rendezvous.join
    // normally, so the hardware-device fallback is not needed.
    if (rp.joinFallback) { clearTimeout(rp.joinFallback); rp.joinFallback = null; }
    rp.joined = true;
    const sessionId = (msg.sessionId ?? '').trim();
    const deviceId = (msg.deviceId ?? '').trim();
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

    const roomId = makeVoiceRoomId({
      hostPeerId: this.opts.peerId,
      sessionId,
      ...(deviceId ? { deviceId } : {}),
    });

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
        ...(this.opts.ttsCatalogProvider ? { ttsCatalogProvider: this.opts.ttsCatalogProvider } : {}),
        ...(this.opts.sttCatalogProvider ? { sttCatalogProvider: this.opts.sttCatalogProvider } : {}),
        ...(this.opts.newSessionDestinationsProvider
          ? { newSessionDestinationsProvider: this.opts.newSessionDestinationsProvider }
          : {}),
        ...(this.opts.newSessionDiscordDestinationsProvider
          ? { newSessionDiscordDestinationsProvider: this.opts.newSessionDiscordDestinationsProvider }
          : {}),
        ...(this.opts.newSessionSlackDestinationsProvider
          ? { newSessionSlackDestinationsProvider: this.opts.newSessionSlackDestinationsProvider }
          : {}),
        ...(this.opts.newSessionCreateResponder
          ? { newSessionCreateResponder: this.opts.newSessionCreateResponder }
          : {}),
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

  private async sendRendezvousTtsCatalog(rp: RendezvousPeer): Promise<void> {
    try {
      const loadCatalog = this.opts.ttsCatalogProvider ?? (() => defaultTtsCatalogCache.get());
      this.sendRendezvous(rp, daemonToPhone.ttsCatalog(await loadCatalog()));
    } catch {
      this.sendRendezvous(rp, daemonToPhone.ttsCatalog(createEmptyTtsCatalog()));
    }
  }

  private async sendRendezvousSttCatalog(rp: RendezvousPeer): Promise<void> {
    try {
      const loadCatalog = this.opts.sttCatalogProvider ?? (() => defaultSttCatalogCache.get());
      this.sendRendezvous(rp, daemonToPhone.sttCatalog(await loadCatalog()));
    } catch {
      this.sendRendezvous(rp, daemonToPhone.sttCatalog(createEmptySttCatalog()));
    }
  }

  private async sendRendezvousNewSessionDestinations(rp: RendezvousPeer): Promise<void> {
    const immediateCatalog = createWebchatOnlyNewSessionDestinationsCatalog();
    this.sendRendezvous(rp, daemonToPhone.sessionsDestinations(immediateCatalog));
    try {
      const loadCatalog = this.opts.newSessionDestinationsProvider
        ?? (() => getNewSessionDestinationsWithOpenClaw({
          ...(this.opts.newSessionDiscordDestinationsProvider
            ? { loadDiscordDestinations: this.opts.newSessionDiscordDestinationsProvider }
            : {}),
          ...(this.opts.newSessionSlackDestinationsProvider
            ? { loadSlackDestinations: this.opts.newSessionSlackDestinationsProvider }
            : {}),
        }));
      const catalog = await loadCatalog();
      if (!sameNewSessionDestinationProviders(immediateCatalog, catalog)) {
        this.sendRendezvous(rp, daemonToPhone.sessionsDestinations(catalog));
      }
    } catch {
      // The immediate webchat catalog has already kept local sessions usable.
    }
  }

  private async sendRendezvousNewSessionCreateResponse(
    rp: RendezvousPeer,
    msg: NewSessionCreateRequestLike,
  ): Promise<void> {
    const respond = this.opts.newSessionCreateResponder ?? buildNewSessionCreateResponse;
    try {
      this.sendRendezvous(rp, await respond(msg));
    } catch {
      this.sendRendezvous(rp, daemonToPhone.sessionsCreateError(
        typeof msg.requestId === 'string' ? msg.requestId : '',
        'new_session_create_failed',
      ));
    }
  }

  private sendRendezvous(rp: RendezvousPeer, msg: unknown): void {
    const data = JSON.stringify(msg);
    // Try data channel first
    if (!rp.peer.destroyed) {
      try {
        rp.peer.send(data);
        return;
      } catch (err) {
        console.error(`[peer] rendezvous send via channel failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Fallback: send via signaling server (SSE)
    this.sendRendezvousViaSignal(rp, msg);
  }

  private sendRendezvousViaSignal(rp: RendezvousPeer, msg: unknown): void {
    const data = JSON.stringify(msg);
    void this.signalClient
      .sendSignal(rp.remoteId, { type: 'rendezvous', data } as unknown as SignalData)
      .catch((err) => {
        console.error(`[peer] rendezvous send via signal failed: ${err instanceof Error ? err.message : err}`);
      });
  }

  // Test/manager hook for tracking active rooms.
  get activeRoomIds(): string[] {
    return Array.from(this.voiceSessions.keys());
  }
}


function sameNewSessionDestinationProviders(
  left: NewSessionDestinationsCatalog,
  right: NewSessionDestinationsCatalog,
): boolean {
  return JSON.stringify(left.providers) === JSON.stringify(right.providers);
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
