// One RtcClient per join token, hoisted so both Handoff and Driving
// screens can consume the same connection + control message stream.

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

const DEFAULT_RENDEZVOUS_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_CT_RENDEZVOUS_URL || '';

export interface RtcContextValue {
  status: RtcStatus;
  detail?: string;
  sendControl: (msg: ControlMessage) => void;
  sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
  // Null when no join token was provided on the URL — the voice loop
  // uses this to surface a "daemon not connected" blocker.
  hasClient: boolean;
}

const noop = () => {};

const Ctx = createContext<RtcContextValue>({
  status: 'idle',
  detail: undefined,
  sendControl: noop,
  sendBinary: noop,
  addControlListener: () => noop,
  hasClient: false,
});

export function RtcProvider({
  joinToken,
  rendezvousUrl,
  children,
}: {
  joinToken?: string;
  rendezvousUrl?: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<RtcStatus>('idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const clientRef = useRef<RtcClient | null>(null);
  const listenersRef = useRef<Set<(msg: ControlMessage) => void>>(new Set());

  const effectiveRendezvous = rendezvousUrl || DEFAULT_RENDEZVOUS_URL;

  useEffect(() => {
    if (!joinToken) return;
    if (!effectiveRendezvous) {
      setStatus('error');
      setDetail('missing_rendezvous_url');
      return;
    }

    const client = new RtcClient({
      rendezvousUrl: effectiveRendezvous,
      token: joinToken,
      onStatusChange: (s, d) => {
        setStatus(s);
        setDetail(d);
      },
      onControlMessage: (msg) => {
        for (const fn of listenersRef.current) fn(msg);
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [joinToken, effectiveRendezvous]);

  const sendControl = useCallback((msg: ControlMessage) => {
    clientRef.current?.sendControl(msg);
  }, []);

  const sendBinary = useCallback((bytes: ArrayBuffer | Uint8Array) => {
    clientRef.current?.sendBinary(bytes);
  }, []);

  const addControlListener = useCallback((fn: (msg: ControlMessage) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const value = useMemo<RtcContextValue>(
    () => ({
      status,
      detail,
      sendControl,
      sendBinary,
      addControlListener,
      hasClient: !!joinToken,
    }),
    [status, detail, sendControl, sendBinary, addControlListener, joinToken],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRtc(): RtcContextValue {
  return useContext(Ctx);
}
