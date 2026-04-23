// One RtcClient per host peer ID, hoisted so both Handoff and Driving
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

export interface RtcContextValue {
  status: RtcStatus;
  detail?: string;
  sendControl: (msg: ControlMessage) => void;
  sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
  // Null when no host peer ID was provided on the URL — the voice loop
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
  hostPeerId,
  children,
}: {
  hostPeerId?: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<RtcStatus>('idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const clientRef = useRef<RtcClient | null>(null);
  const listenersRef = useRef<Set<(msg: ControlMessage) => void>>(new Set());

  useEffect(() => {
    if (!hostPeerId) return;

    const client = new RtcClient({
      hostPeerId,
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
  }, [hostPeerId]);

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
      hasClient: !!hostPeerId,
    }),
    [status, detail, sendControl, sendBinary, addControlListener, hostPeerId],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRtc(): RtcContextValue {
  return useContext(Ctx);
}
