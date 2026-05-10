// One RtcClient per host peer ID, hoisted so Driving can consume the
// connection + control message stream.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RtcClient, type ControlMessage, type RtcStatus } from './client';
import {
  loadFavoriteRecentSessions,
  favoriteRecentSessionIdentity,
  mergeRecentSessionsWithFavorites,
  normalizeFavoriteRecentSession,
  reconcileFavoriteRecentSessions,
  removeFavoriteRecentSession,
  saveFavoriteRecentSession,
  type FavoriteRecentSession,
  type RecentSessionFavoriteState,
} from '../storage';
import { attachDaemonRemoteStream, detachDaemonRemoteStream } from '../voice/tts';
import {
  PROTOCOL_FEATURES,
  isDaemonSupportedProtocol,
  phoneToDaemon,
  type DeliveryTarget,
  type ProtocolFeature,
  type RecentSession,
  type RecentSessionsSnapshot,
  type SttCatalog,
  type TtsCatalog,
  type VoiceSettings,
} from '../voice/protocol';

export type RecentSessionsSupportStatus = 'unknown' | 'probing' | 'supported' | 'unsupported';

type DaemonNegotiationMode = 'idle' | 'pending' | 'negotiated' | 'legacy' | 'unsupported';

interface DaemonNegotiationState {
  roomId?: string;
  mode: DaemonNegotiationMode;
  features: string[];
}

const RECENT_SESSIONS_SUPPORT_TIMEOUT_MS = 12_000;
const CLIENT_HELLO_FALLBACK_MS = 250;
const RTC_RETRY_BACKOFF_MS = [1_000, 2_500, 5_000, 10_000, 15_000] as const;

export interface RtcContextValue {
  status: RtcStatus;
  detail?: string;
  sendControl: (msg: ControlMessage) => void;
  sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
  addBinaryListener: (fn: (bytes: ArrayBuffer) => void) => () => void;
  // Subscribe for the remote audio MediaStream from the daemon. Fires
  // immediately with the existing stream if one is already attached, so
  // late subscribers don't miss the daemon's first stream.
  addRemoteStreamListener: (fn: (stream: MediaStream) => void) => () => void;
  ttsCatalog: TtsCatalog | null;
  requestTtsCatalog: () => void;
  sttCatalog: SttCatalog | null;
  requestSttCatalog: () => void;
  recentSessions: RecentSessionFavoriteState[];
  recentSessionsGeneratedAt?: string;
  toggleRecentSessionFavorite: (session: RecentSession) => void;
  recentSessionsResponseSeq: number;
  recentSessionsSupportStatus: RecentSessionsSupportStatus;
  requestRecentSessions: () => void;
  retryConnection: () => void;
  canRetryConnection: boolean;
  hasClient: boolean;
}

const noop = () => {};

const Ctx = createContext<RtcContextValue>({
  status: 'idle',
  detail: undefined,
  sendControl: noop,
  sendBinary: noop,
  addControlListener: () => noop,
  addBinaryListener: () => noop,
  addRemoteStreamListener: () => noop,
  ttsCatalog: null,
  requestTtsCatalog: noop,
  sttCatalog: null,
  requestSttCatalog: noop,
  recentSessions: [],
  recentSessionsGeneratedAt: undefined,
  toggleRecentSessionFavorite: noop,
  recentSessionsResponseSeq: 0,
  recentSessionsSupportStatus: 'unknown',
  requestRecentSessions: noop,
  retryConnection: noop,
  canRetryConnection: false,
  hasClient: false,
});

export function normalizeVoiceSettingsForRtc(voiceSettings?: VoiceSettings | null): VoiceSettings | null {
  if (!voiceSettings) return null;
  const ttsProviderId = trimmedString(voiceSettings.tts?.providerId);
  const ttsModel = trimmedString(voiceSettings.tts?.model);
  const effectiveVoice = trimmedString(voiceSettings.tts?.voice) ?? trimmedString(voiceSettings.voice);
  const sttProviderId = trimmedString(voiceSettings.stt?.providerId);
  const sttModel = trimmedString(voiceSettings.stt?.model);

  const normalized: VoiceSettings = {};
  if (effectiveVoice) normalized.voice = effectiveVoice;
  if (ttsProviderId || ttsModel || effectiveVoice) {
    normalized.tts = {
      ...(ttsProviderId ? { providerId: ttsProviderId } : {}),
      ...(ttsModel ? { model: ttsModel } : {}),
      ...(effectiveVoice ? { voice: effectiveVoice } : {}),
    };
  }
  if (sttProviderId || sttModel) {
    normalized.stt = {
      ...(sttProviderId ? { providerId: sttProviderId } : {}),
      ...(sttModel ? { model: sttModel } : {}),
    };
  }

  return normalized.voice || normalized.tts || normalized.stt ? normalized : null;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRetryableConnectionState(status: RtcStatus, detail: string | undefined, activeRoomId: string | undefined): boolean {
  return (
    !!activeRoomId &&
    detail !== 'session_replaced' &&
    detail !== 'unsupported_daemon_protocol' &&
    (status === 'error' || status === 'closed')
  );
}

function retryBackoffMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RTC_RETRY_BACKOFF_MS.length - 1));
  return RTC_RETRY_BACKOFF_MS[index];
}

function emptyNegotiation(roomId?: string): DaemonNegotiationState {
  return { roomId, mode: 'idle', features: [] };
}

function isNegotiationCurrent(negotiation: DaemonNegotiationState, roomId?: string): boolean {
  return !!roomId && negotiation.roomId === roomId;
}

function isNegotiationResolved(negotiation: DaemonNegotiationState, roomId?: string): boolean {
  return (
    isNegotiationCurrent(negotiation, roomId) &&
    (negotiation.mode === 'negotiated' || negotiation.mode === 'legacy')
  );
}

function negotiatedFeatures(msg: ControlMessage): string[] {
  if (!Array.isArray(msg.features)) return [];
  return msg.features.filter((feature): feature is string => typeof feature === 'string');
}

function allowsProtocolFeature(
  negotiation: DaemonNegotiationState,
  roomId: string | undefined,
  feature: ProtocolFeature,
): boolean {
  if (!isNegotiationCurrent(negotiation, roomId)) return false;
  if (negotiation.mode === 'legacy') return true;
  return negotiation.mode === 'negotiated' && negotiation.features.includes(feature);
}

function requiredFeatureForControlMessage(msg: ControlMessage): ProtocolFeature | null {
  switch (msg.t) {
    case 'tts.catalog.request':
      return PROTOCOL_FEATURES.ttsCatalog;
    case 'stt.catalog.request':
      return PROTOCOL_FEATURES.sttCatalog;
    case 'sessions.list.request':
    case 'sessions.list.subscribe':
    case 'sessions.list.unsubscribe':
      return PROTOCOL_FEATURES.sessionsList;
    case 'sessions.catalog.request':
      return PROTOCOL_FEATURES.sessionsCatalog;
    default:
      return null;
  }
}

function allowsControlMessage(
  negotiation: DaemonNegotiationState,
  roomId: string | undefined,
  msg: ControlMessage,
): boolean {
  if (isNegotiationCurrent(negotiation, roomId) && negotiation.mode === 'unsupported') return false;
  const feature = requiredFeatureForControlMessage(msg);
  return !feature || allowsProtocolFeature(negotiation, roomId, feature);
}

function allowsBinaryMessage(negotiation: DaemonNegotiationState, roomId: string | undefined): boolean {
  return !(isNegotiationCurrent(negotiation, roomId) && negotiation.mode === 'unsupported');
}

function voiceSelectionKey(voiceSettings?: VoiceSettings | null): string | null {
  const normalized = normalizeVoiceSettingsForRtc(voiceSettings);
  if (!normalized) return null;
  const providerId = normalized.tts?.providerId ?? '';
  const model = normalized.tts?.model ?? '';
  const voice = normalized.tts?.voice ?? normalized.voice ?? '';
  const legacyVoice = normalized.voice ?? '';
  const sttProviderId = normalized.stt?.providerId ?? '';
  const sttModel = normalized.stt?.model ?? '';
  if (!providerId && !model && !voice && !legacyVoice && !sttProviderId && !sttModel) return null;
  return JSON.stringify({ providerId, model, voice, legacyVoice, sttProviderId, sttModel });
}

export interface RtcRendezvous {
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: DeliveryTarget;
}

export function RtcProvider({
  hostPeerId,
  rendezvous,
  voiceSettings,
  children,
}: {
  hostPeerId?: string;
  rendezvous?: RtcRendezvous | null;
  voiceSettings?: VoiceSettings | null;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<RtcStatus>('idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [ttsCatalog, setTtsCatalog] = useState<TtsCatalog | null>(null);
  const [sttCatalog, setSttCatalog] = useState<SttCatalog | null>(null);
  const [recentSessionsSnapshot, setRecentSessionsSnapshot] = useState<RecentSessionsSnapshot>({
    generatedAt: '',
    sessions: [],
  });
  const [favoriteRecentSessions, setFavoriteRecentSessions] = useState<FavoriteRecentSession[]>(() =>
    loadFavoriteRecentSessions(hostPeerId),
  );
  const [recentSessionsResponseSeq, setRecentSessionsResponseSeq] = useState(0);
  const [recentSessionsSupportStatus, setRecentSessionsSupportStatus] =
    useState<RecentSessionsSupportStatus>('unknown');
  const [daemonNegotiation, setDaemonNegotiation] = useState<DaemonNegotiationState>(() =>
    emptyNegotiation(hostPeerId),
  );
  const [retrySeq, setRetrySeq] = useState(0);
  const [autoRetryAttempt, setAutoRetryAttempt] = useState(0);
  // The active room flips from the rendezvous host to the
  // deterministic per-session voice room after `rendezvous.accept`
  // arrives. Each flip re-creates the underlying RtcClient.
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>(hostPeerId);
  const normalizedVoiceSettings = useMemo(
    () => normalizeVoiceSettingsForRtc(voiceSettings),
    [voiceSettings],
  );
  const rendezvousKey = rendezvous && hostPeerId
    ? `${hostPeerId}:${rendezvous.sessionId}`
    : null;
  useEffect(() => {
    setStatus('idle');
    setActiveRoomId(hostPeerId);
    setRecentSessionsSupportStatus('unknown');
    setRecentSessionsSnapshot({ generatedAt: '', sessions: [] });
    setFavoriteRecentSessions(loadFavoriteRecentSessions(hostPeerId));
    setDaemonNegotiation(emptyNegotiation(hostPeerId));
    setAutoRetryAttempt(0);
  }, [hostPeerId]);

  const clientRef = useRef<RtcClient | null>(null);
  const appliedVoiceSettingsRef = useRef<{ rendezvousKey: string; key: string } | null>(null);
  const lastSentVoiceRef = useRef<string | null>(null);
  const catalogRequestedRoomRef = useRef<string | null>(null);
  const sessionsSubscribedRoomRef = useRef<string | null>(null);
  const previousRendezvousKeyRef = useRef<string | null>(rendezvousKey);
  const controlListenersRef = useRef<Set<(msg: ControlMessage) => void>>(new Set());
  const binaryListenersRef = useRef<Set<(bytes: ArrayBuffer) => void>>(new Set());
  const remoteStreamListenersRef = useRef<Set<(stream: MediaStream) => void>>(new Set());
  const remoteStreamRef = useRef<MediaStream | null>(null);

  const resetRetryConnectionRefs = useCallback(() => {
    lastSentVoiceRef.current = null;
    catalogRequestedRoomRef.current = null;
    sessionsSubscribedRoomRef.current = null;
  }, []);

  const applyRecentSessionsSnapshot = useCallback((snapshot: RecentSessionsSnapshot) => {
    setRecentSessionsSnapshot(snapshot);
    setFavoriteRecentSessions(reconcileFavoriteRecentSessions(hostPeerId, snapshot.sessions));
  }, [hostPeerId]);

  useEffect(() => {
    if (!activeRoomId) return;

    let active = true;
    let client: RtcClient;
    const deliverControlMessage = (msg: ControlMessage) => {
      if (!active) return;
      if (msg.t === 'daemon.hello') {
        if (!isDaemonSupportedProtocol(msg.protocol)) {
          setDaemonNegotiation((current) => {
            if (current.roomId !== activeRoomId || current.mode === 'unsupported') return current;
            return { roomId: activeRoomId, mode: 'unsupported', features: [] };
          });
          setDetail('unsupported_daemon_protocol');
          setStatus('error');
          return;
        }
        const features = negotiatedFeatures(msg);
        setDaemonNegotiation((current) => {
          if (current.roomId !== activeRoomId || current.mode === 'unsupported') return current;
          return { roomId: activeRoomId, mode: 'negotiated', features };
        });
      }
      if (msg.t === 'daemon.unsupported') {
        setDaemonNegotiation({ roomId: activeRoomId, mode: 'unsupported', features: [] });
        setDetail(typeof msg.message === 'string' ? msg.message : 'unsupported_daemon_protocol');
        setStatus('error');
      }
      if (msg.t === 'session.replaced') {
        setDetail('session_replaced');
        setStatus('closed');
        setTimeout(() => {
          if (active) client.close();
        }, 0);
      }
      if (msg.t === 'tts.catalog' && msg.catalog && typeof msg.catalog === 'object') {
        setTtsCatalog(msg.catalog as TtsCatalog);
      }
      if (msg.t === 'stt.catalog' && msg.catalog && typeof msg.catalog === 'object') {
        setSttCatalog(msg.catalog as SttCatalog);
      }
      if (msg.t === 'sessions.list' && Array.isArray(msg.sessions)) {
        setRecentSessionsSupportStatus('supported');
        setRecentSessionsResponseSeq((seq) => seq + 1);
        applyRecentSessionsSnapshot({
          generatedAt: typeof msg.generatedAt === 'string' ? msg.generatedAt : '',
          sessions: msg.sessions as RecentSession[],
        });
      }
      if (
        msg.t === 'sessions.catalog' &&
        msg.catalog &&
        typeof msg.catalog === 'object' &&
        Array.isArray((msg.catalog as { sessions?: unknown }).sessions)
      ) {
        const catalog = msg.catalog as Partial<RecentSessionsSnapshot>;
        setRecentSessionsSupportStatus('supported');
        setRecentSessionsResponseSeq((seq) => seq + 1);
        applyRecentSessionsSnapshot({
          generatedAt: typeof catalog.generatedAt === 'string' ? catalog.generatedAt : '',
          sessions: catalog.sessions as RecentSession[],
        });
      }
      for (const fn of controlListenersRef.current) fn(msg);
    };
    client = new RtcClient({
      hostPeerId: activeRoomId,
      onStatusChange: (s, d) => {
        if (!active) return;
        setStatus(s);
        setDetail((prev) =>
          d ?? (prev === 'session_replaced' || prev === 'unsupported_daemon_protocol' ? prev : undefined),
        );
      },
      onControlMessage: (msg) => {
        if (msg.t === 'session.snapshot' && Array.isArray(msg.events)) {
          deliverControlMessage(msg);
          const events = msg.events
            .filter((event): event is { id: number; msg: ControlMessage } => (
              !!event &&
              typeof event === 'object' &&
              typeof (event as { id?: unknown }).id === 'number' &&
              !!(event as { msg?: unknown }).msg &&
              typeof (event as { msg?: unknown }).msg === 'object'
            ))
            .sort((a, b) => a.id - b.id);
          for (const event of events) deliverControlMessage(event.msg);
          return;
        }
        deliverControlMessage(msg);
      },
      onBinaryMessage: (bytes) => {
        if (!active) return;
        for (const fn of binaryListenersRef.current) fn(bytes);
      },
      onRemoteStream: (stream) => {
        if (!active) return;
        remoteStreamRef.current = stream;
        // Attach to the hidden audio element immediately so playback
        // can start the moment the daemon's first audio frame arrives.
        // unlockDaemonTtsAudio() (called from the PTT gesture) has
        // already primed the element with a play() call.
        attachDaemonRemoteStream(stream);
        for (const fn of remoteStreamListenersRef.current) fn(stream);
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      active = false;
      client.close();
      clientRef.current = null;
      if (remoteStreamRef.current) detachDaemonRemoteStream(remoteStreamRef.current);
      remoteStreamRef.current = null;
    };
  }, [activeRoomId, applyRecentSessionsSnapshot, retrySeq]);

  useEffect(() => {
    if (previousRendezvousKeyRef.current !== rendezvousKey) {
      previousRendezvousKeyRef.current = rendezvousKey;
      appliedVoiceSettingsRef.current = null;
      lastSentVoiceRef.current = null;
      catalogRequestedRoomRef.current = null;
      sessionsSubscribedRoomRef.current = null;
      setRecentSessionsSupportStatus('unknown');
      setDaemonNegotiation(emptyNegotiation(hostPeerId));
      setDetail(undefined);
      setAutoRetryAttempt(0);
      if (activeRoomId !== hostPeerId) setStatus('idle');
      setActiveRoomId(hostPeerId);
    }
  }, [rendezvousKey, hostPeerId, activeRoomId]);

  useEffect(() => {
    setDaemonNegotiation(emptyNegotiation(activeRoomId));
  }, [activeRoomId, retrySeq]);

  const canRetryConnection = isRetryableConnectionState(status, detail, activeRoomId);

  const retryConnection = useCallback(() => {
    if (!isRetryableConnectionState(status, detail, activeRoomId)) return;
    setAutoRetryAttempt(0);
    setDetail(undefined);
    setStatus('idle');
    resetRetryConnectionRefs();
    setRetrySeq((seq) => seq + 1);
  }, [activeRoomId, detail, resetRetryConnectionRefs, status]);

  useEffect(() => {
    if (status === 'open') setAutoRetryAttempt(0);
  }, [status]);

  useEffect(() => {
    if (!canRetryConnection) return;
    const timeout = setTimeout(() => {
      setAutoRetryAttempt((attempt) => Math.min(attempt + 1, RTC_RETRY_BACKOFF_MS.length - 1));
      setDetail(undefined);
      setStatus('idle');
      resetRetryConnectionRefs();
      setRetrySeq((seq) => seq + 1);
    }, retryBackoffMs(autoRetryAttempt));

    return () => clearTimeout(timeout);
  }, [autoRetryAttempt, canRetryConnection, resetRetryConnectionRefs]);

  useEffect(() => {
    if (!activeRoomId) return;
    if (status !== 'open') return;
    setDaemonNegotiation({ roomId: activeRoomId, mode: 'pending', features: [] });
    clientRef.current?.sendControl(phoneToDaemon.clientHello());

    const timeout = setTimeout(() => {
      setDaemonNegotiation((current) => {
        if (current.roomId !== activeRoomId || current.mode !== 'pending') return current;
        return { roomId: activeRoomId, mode: 'legacy', features: [] };
      });
    }, CLIENT_HELLO_FALLBACK_MS);

    return () => clearTimeout(timeout);
  }, [activeRoomId, status, retrySeq]);

  // Rendezvous orchestration: when we are still on the rendezvous
  // (host) room and the data channel comes up, send rendezvous.join
  // once and wait for the daemon to point us at the deterministic
  // per-session voice room.
  useEffect(() => {
    if (!rendezvous || !hostPeerId) return;
    if (activeRoomId !== hostPeerId) return;
    if (status !== 'open') return;
    if (!isNegotiationResolved(daemonNegotiation, activeRoomId)) return;
    const settingsKey = voiceSelectionKey(normalizedVoiceSettings);
    if (settingsKey && rendezvousKey) {
      appliedVoiceSettingsRef.current = { rendezvousKey, key: settingsKey };
    }
    clientRef.current?.sendControl(
      phoneToDaemon.rendezvousJoin({
        sessionId: rendezvous.sessionId,
        ...(rendezvous.sessionKey ? { sessionKey: rendezvous.sessionKey } : {}),
        ...(rendezvous.channel ? { channel: rendezvous.channel } : {}),
        ...(rendezvous.target ? { target: rendezvous.target } : {}),
        ...(rendezvous.accountId ? { accountId: rendezvous.accountId } : {}),
        ...(rendezvous.delivery ? { delivery: rendezvous.delivery } : {}),
        ...(normalizedVoiceSettings ? { settings: normalizedVoiceSettings } : {}),
      }),
    );
  }, [rendezvous, rendezvousKey, hostPeerId, activeRoomId, status, daemonNegotiation, normalizedVoiceSettings]);

  // Once the voice room is open, push subsequent voice-setting changes
  // so the next TTS turn picks them up without reconnecting.
  useEffect(() => {
    if (!rendezvous || !hostPeerId || !rendezvousKey) return;
    if (activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (!isNegotiationResolved(daemonNegotiation, activeRoomId)) return;
    const settingsToSend = normalizedVoiceSettings;
    const key = voiceSelectionKey(settingsToSend);
    const applied = appliedVoiceSettingsRef.current;
    const appliedKey = applied?.rendezvousKey === rendezvousKey ? applied.key : null;
    if (!key) {
      if (appliedKey) {
        clientRef.current?.sendControl(phoneToDaemon.settingsUpdate({}));
        appliedVoiceSettingsRef.current = null;
        lastSentVoiceRef.current = null;
      }
      return;
    }
    if (!settingsToSend) return;
    if (lastSentVoiceRef.current === key) return;
    appliedVoiceSettingsRef.current = { rendezvousKey, key };
    lastSentVoiceRef.current = key;
    clientRef.current?.sendControl(phoneToDaemon.settingsUpdate(settingsToSend));
  }, [normalizedVoiceSettings, rendezvous, rendezvousKey, hostPeerId, activeRoomId, status, daemonNegotiation]);

  const requestTtsCatalog = useCallback(() => {
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (!allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.ttsCatalog)) return;
    clientRef.current?.sendControl(phoneToDaemon.ttsCatalogRequest());
  }, [activeRoomId, daemonNegotiation, hostPeerId, status]);

  const requestSttCatalog = useCallback(() => {
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (!allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.sttCatalog)) return;
    clientRef.current?.sendControl(phoneToDaemon.sttCatalogRequest());
  }, [activeRoomId, daemonNegotiation, hostPeerId, status]);

  const requestRecentSessions = useCallback(() => {
    if (!activeRoomId) return;
    if (rendezvous && activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (!isNegotiationResolved(daemonNegotiation, activeRoomId)) return;
    const allowList = allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.sessionsList);
    const allowCatalog = allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.sessionsCatalog);
    if (!allowList && !allowCatalog) {
      setRecentSessionsSupportStatus('unsupported');
      return;
    }
    setRecentSessionsSupportStatus((current) =>
      current === 'supported' ? current : 'probing',
    );
    if (allowList) clientRef.current?.sendControl(phoneToDaemon.sessionsListRequest());
    if (allowCatalog) clientRef.current?.sendControl(phoneToDaemon.sessionsCatalogRequest());
  }, [activeRoomId, daemonNegotiation, hostPeerId, rendezvous, status]);

  useEffect(() => {
    if (!hostPeerId || !activeRoomId) return;
    if (status !== 'open') return;
    const onRendezvousLane = activeRoomId === hostPeerId;
    if (rendezvous && onRendezvousLane) return;
    if (!isNegotiationResolved(daemonNegotiation, activeRoomId)) return;

    if (rendezvous && !onRendezvousLane && catalogRequestedRoomRef.current !== activeRoomId) {
      catalogRequestedRoomRef.current = activeRoomId;
      requestTtsCatalog();
      requestSttCatalog();
    }
    if (sessionsSubscribedRoomRef.current !== activeRoomId) {
      sessionsSubscribedRoomRef.current = activeRoomId;
      const allowList = allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.sessionsList);
      const allowCatalog = allowsProtocolFeature(daemonNegotiation, activeRoomId, PROTOCOL_FEATURES.sessionsCatalog);
      if (!allowList && !allowCatalog) {
        setRecentSessionsSupportStatus('unsupported');
        return;
      }
      setRecentSessionsSupportStatus((current) =>
        current === 'supported' ? current : 'probing',
      );
      if (allowList) clientRef.current?.sendControl(phoneToDaemon.sessionsListSubscribe());
      if (allowCatalog) clientRef.current?.sendControl(phoneToDaemon.sessionsCatalogRequest());
    }
  }, [
    rendezvous,
    hostPeerId,
    activeRoomId,
    status,
    daemonNegotiation,
    requestTtsCatalog,
    requestSttCatalog,
  ]);

  useEffect(() => {
    if (activeRoomId === hostPeerId) {
      lastSentVoiceRef.current = null;
      catalogRequestedRoomRef.current = null;
      sessionsSubscribedRoomRef.current = null;
      if (rendezvous) setRecentSessionsSupportStatus('unknown');
    }
  }, [activeRoomId, hostPeerId, rendezvous]);

  useEffect(() => {
    if (!activeRoomId || status !== 'open' || (rendezvous && activeRoomId === hostPeerId)) {
      setRecentSessionsSupportStatus('unknown');
    }
  }, [activeRoomId, hostPeerId, rendezvous, status]);

  useEffect(() => {
    if (!hostPeerId || !activeRoomId) return;
    if (rendezvous && activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (recentSessionsSupportStatus !== 'probing') return;

    const timeout = setTimeout(() => {
      setRecentSessionsSupportStatus((current) => {
        const hasRecentSessionResponse =
          recentSessionsSnapshot.sessions.length > 0 || !!recentSessionsSnapshot.generatedAt;
        return current === 'probing' && !hasRecentSessionResponse ? 'unsupported' : current;
      });
    }, RECENT_SESSIONS_SUPPORT_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [rendezvous, hostPeerId, activeRoomId, status, recentSessionsSupportStatus, recentSessionsSnapshot]);

  useEffect(() => {
    if (!rendezvous) return;
    const off = (msg: ControlMessage) => {
      if (msg.t === 'rendezvous.accept' && typeof msg.roomId === 'string') {
        setStatus('idle');
        setActiveRoomId(msg.roomId);
        return;
      }
      if (msg.t === 'rendezvous.error') {
        const message = typeof msg.message === 'string' ? msg.message : 'rendezvous_error';
        if (
          message === 'unexpected_message' &&
          activeRoomId === hostPeerId &&
          status === 'open' &&
          daemonNegotiation.roomId === activeRoomId &&
          (daemonNegotiation.mode === 'pending' || daemonNegotiation.mode === 'legacy')
        ) {
          if (daemonNegotiation.mode === 'pending') {
            setDaemonNegotiation({ roomId: activeRoomId, mode: 'legacy', features: [] });
          }
          setDetail(undefined);
          return;
        }
        setDetail(message);
        setStatus('error');
      }
    };
    controlListenersRef.current.add(off);
    return () => {
      controlListenersRef.current.delete(off);
    };
  }, [activeRoomId, daemonNegotiation, hostPeerId, rendezvous, status]);

  const sendControl = useCallback((msg: ControlMessage) => {
    if (!allowsControlMessage(daemonNegotiation, activeRoomId, msg)) return;
    clientRef.current?.sendControl(msg);
  }, [activeRoomId, daemonNegotiation]);

  const sendBinary = useCallback((bytes: ArrayBuffer | Uint8Array) => {
    if (!allowsBinaryMessage(daemonNegotiation, activeRoomId)) return;
    clientRef.current?.sendBinary(bytes);
  }, [activeRoomId, daemonNegotiation]);

  const addControlListener = useCallback((fn: (msg: ControlMessage) => void) => {
    controlListenersRef.current.add(fn);
    return () => {
      controlListenersRef.current.delete(fn);
    };
  }, []);

  const addBinaryListener = useCallback((fn: (bytes: ArrayBuffer) => void) => {
    binaryListenersRef.current.add(fn);
    return () => {
      binaryListenersRef.current.delete(fn);
    };
  }, []);

  const toggleRecentSessionFavorite = useCallback((session: RecentSession) => {
    const normalized = normalizeFavoriteRecentSession(session);
    if (!hostPeerId || !normalized) return;
    const current = loadFavoriteRecentSessions(hostPeerId);
    const identity = favoriteRecentSessionIdentity(normalized);
    const favorite = !!identity && current.some((item) => favoriteRecentSessionIdentity(item) === identity);
    if (favorite) {
      removeFavoriteRecentSession(hostPeerId, normalized);
    } else {
      saveFavoriteRecentSession(hostPeerId, normalized);
    }
    setFavoriteRecentSessions(loadFavoriteRecentSessions(hostPeerId));
  }, [hostPeerId]);

  const mergedRecentSessions = useMemo(
    () => mergeRecentSessionsWithFavorites(recentSessionsSnapshot.sessions, favoriteRecentSessions),
    [favoriteRecentSessions, recentSessionsSnapshot.sessions],
  );

  const addRemoteStreamListener = useCallback((fn: (stream: MediaStream) => void) => {
    remoteStreamListenersRef.current.add(fn);
    if (remoteStreamRef.current) {
      try {
        fn(remoteStreamRef.current);
      } catch (err) {
        console.error('[rtc] remote stream listener threw on attach', err);
      }
    }
    return () => {
      remoteStreamListenersRef.current.delete(fn);
    };
  }, []);

  const value = useMemo<RtcContextValue>(
    () => ({
      status,
      detail,
      sendControl,
      sendBinary,
      addControlListener,
      addBinaryListener,
      addRemoteStreamListener,
      ttsCatalog,
      requestTtsCatalog,
      sttCatalog,
      requestSttCatalog,
      recentSessions: mergedRecentSessions,
      recentSessionsGeneratedAt: recentSessionsSnapshot.generatedAt || undefined,
      toggleRecentSessionFavorite,
      recentSessionsResponseSeq,
      recentSessionsSupportStatus,
      requestRecentSessions,
      retryConnection,
      canRetryConnection,
      hasClient: !!hostPeerId,
    }),
    [
      status,
      detail,
      sendControl,
      sendBinary,
      addControlListener,
      addBinaryListener,
      addRemoteStreamListener,
      ttsCatalog,
      requestTtsCatalog,
      sttCatalog,
      requestSttCatalog,
      mergedRecentSessions,
      recentSessionsSnapshot.generatedAt,
      recentSessionsResponseSeq,
      recentSessionsSupportStatus,
      requestRecentSessions,
      retryConnection,
      canRetryConnection,
      hostPeerId,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRtc(): RtcContextValue {
  return useContext(Ctx);
}
