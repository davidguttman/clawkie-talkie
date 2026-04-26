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
import { attachDaemonRemoteStream } from '../voice/tts';

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
  const controlListenersRef = useRef<Set<(msg: ControlMessage) => void>>(new Set());
  const binaryListenersRef = useRef<Set<(bytes: ArrayBuffer) => void>>(new Set());
  const remoteStreamListenersRef = useRef<Set<(stream: MediaStream) => void>>(new Set());
  const remoteStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!hostPeerId) return;

    const client = new RtcClient({
      hostPeerId,
      onStatusChange: (s, d) => {
        setStatus(s);
        setDetail(d);
      },
      onControlMessage: (msg) => {
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
      remoteStreamRef.current = null;
    };
  }, [hostPeerId]);

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
      hostPeerId,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRtc(): RtcContextValue {
  return useContext(Ctx);
}
