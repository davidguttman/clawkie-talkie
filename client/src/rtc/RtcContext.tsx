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
import { attachDaemonRemoteStream, detachDaemonRemoteStream } from '../voice/tts';
import { phoneToDaemon, type DeliveryTarget, type RecentSessionsSnapshot, type SttCatalog, type TtsCatalog, type VoiceSettings } from '../voice/protocol';

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
  sessionsCatalog: RecentSessionsSnapshot | null;
  requestSessionsCatalog: () => void;
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
  sessionsCatalog: null,
  requestSessionsCatalog: noop,
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
  const [sessionsCatalog, setSessionsCatalog] = useState<RecentSessionsSnapshot | null>(null);
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
  }, [hostPeerId]);

  const clientRef = useRef<RtcClient | null>(null);
  const appliedVoiceSettingsRef = useRef<{ rendezvousKey: string; key: string } | null>(null);
  const lastSentVoiceRef = useRef<string | null>(null);
  const catalogRequestedRoomRef = useRef<string | null>(null);
  const previousRendezvousKeyRef = useRef<string | null>(rendezvousKey);
  const controlListenersRef = useRef<Set<(msg: ControlMessage) => void>>(new Set());
  const binaryListenersRef = useRef<Set<(bytes: ArrayBuffer) => void>>(new Set());
  const remoteStreamListenersRef = useRef<Set<(stream: MediaStream) => void>>(new Set());
  const remoteStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!activeRoomId) return;

    let client: RtcClient;
    client = new RtcClient({
      hostPeerId: activeRoomId,
      onStatusChange: (s, d) => {
        setStatus(s);
        setDetail((prev) => d ?? (prev === 'session_replaced' ? prev : undefined));
      },
      onControlMessage: (msg) => {
        if (msg.t === 'session.replaced') {
          setDetail('session_replaced');
          setStatus('closed');
          setTimeout(() => client.close(), 0);
        }
        if (msg.t === 'tts.catalog' && msg.catalog && typeof msg.catalog === 'object') {
          setTtsCatalog(msg.catalog as TtsCatalog);
        }
        if (msg.t === 'stt.catalog' && msg.catalog && typeof msg.catalog === 'object') {
          setSttCatalog(msg.catalog as SttCatalog);
        }
        if (msg.t === 'sessions.catalog' && msg.catalog && typeof msg.catalog === 'object') {
          setSessionsCatalog(msg.catalog as RecentSessionsSnapshot);
        }
        for (const fn of controlListenersRef.current) fn(msg);
      },
      onBinaryMessage: (bytes) => {
        for (const fn of binaryListenersRef.current) fn(bytes);
      },
      onRemoteStream: (stream) => {
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
      client.close();
      clientRef.current = null;
      if (remoteStreamRef.current) detachDaemonRemoteStream(remoteStreamRef.current);
      remoteStreamRef.current = null;
    };
  }, [activeRoomId]);

  useEffect(() => {
    if (previousRendezvousKeyRef.current !== rendezvousKey) {
      previousRendezvousKeyRef.current = rendezvousKey;
      appliedVoiceSettingsRef.current = null;
      lastSentVoiceRef.current = null;
      catalogRequestedRoomRef.current = null;
      setStatus('idle');
      setActiveRoomId(hostPeerId);
    }
  }, [rendezvousKey, hostPeerId]);

  // Rendezvous orchestration: when we are still on the rendezvous
  // (host) room and the data channel comes up, send rendezvous.join
  // once and wait for the daemon to point us at the deterministic
  // per-session voice room.
  useEffect(() => {
    if (!rendezvous || !hostPeerId) return;
    if (activeRoomId !== hostPeerId) return;
    if (status !== 'open') return;
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
  }, [rendezvous, rendezvousKey, hostPeerId, activeRoomId, status, normalizedVoiceSettings]);

  // Once the voice room is open, push subsequent voice-setting changes
  // so the next TTS turn picks them up without reconnecting.
  useEffect(() => {
    if (!rendezvous || !hostPeerId || !rendezvousKey) return;
    if (activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
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
  }, [normalizedVoiceSettings, rendezvous, rendezvousKey, hostPeerId, activeRoomId, status]);

  const requestTtsCatalog = useCallback(() => {
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    clientRef.current?.sendControl(phoneToDaemon.ttsCatalogRequest());
  }, [activeRoomId, hostPeerId, status]);

  const requestSttCatalog = useCallback(() => {
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    clientRef.current?.sendControl(phoneToDaemon.sttCatalogRequest());
  }, [activeRoomId, hostPeerId, status]);

  const requestSessionsCatalog = useCallback(() => {
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    clientRef.current?.sendControl(phoneToDaemon.sessionsCatalogRequest());
  }, [activeRoomId, hostPeerId, status]);

  useEffect(() => {
    if (!rendezvous || !hostPeerId) return;
    if (!activeRoomId || activeRoomId === hostPeerId) return;
    if (status !== 'open') return;
    if (catalogRequestedRoomRef.current === activeRoomId) return;
    catalogRequestedRoomRef.current = activeRoomId;
    requestTtsCatalog();
    requestSttCatalog();
    requestSessionsCatalog();
  }, [rendezvous, hostPeerId, activeRoomId, status, requestTtsCatalog, requestSttCatalog, requestSessionsCatalog]);

  useEffect(() => {
    if (activeRoomId === hostPeerId) {
      lastSentVoiceRef.current = null;
      catalogRequestedRoomRef.current = null;
    }
  }, [activeRoomId, hostPeerId]);

  useEffect(() => {
    if (!rendezvous) return;
    const off = (msg: ControlMessage) => {
      if (msg.t === 'rendezvous.accept' && typeof msg.roomId === 'string') {
        setStatus('idle');
        setActiveRoomId(msg.roomId);
        return;
      }
      if (msg.t === 'rendezvous.error') {
        setDetail(typeof msg.message === 'string' ? msg.message : 'rendezvous_error');
      }
    };
    controlListenersRef.current.add(off);
    return () => {
      controlListenersRef.current.delete(off);
    };
  }, [rendezvous]);

  const sendControl = useCallback((msg: ControlMessage) => {
    clientRef.current?.sendControl(msg);
  }, []);

  const sendBinary = useCallback((bytes: ArrayBuffer | Uint8Array) => {
    clientRef.current?.sendBinary(bytes);
  }, []);

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
      sessionsCatalog,
      requestSessionsCatalog,
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
      sessionsCatalog,
      requestSessionsCatalog,
      hostPeerId,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRtc(): RtcContextValue {
  return useContext(Ctx);
}
