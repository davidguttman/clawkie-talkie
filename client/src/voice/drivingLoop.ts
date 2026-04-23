// Driving state machine.
//
// IDLE → REC → THINK → AI → IDLE. STT now streams through the local
// daemon (phone mic PCM → WebRTC DataChannel → daemon → xAI STT WS →
// transcript events → DataChannel → phone). Reply stays REST-xAI via
// the local provider. TTS is still the browser-direct xAI WebSocket
// path — under the unresolved auth blocker — and will move to the same
// daemon-bridge shape in a follow-up slice.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startDaemonSTT,
  DaemonNotConnectedError,
  MicPermissionError,
  type STTHandle,
} from './sttDaemon';
import { speakWithXaiTTS, type TTSHandle, type TTSOptions } from './tts';
import type { ReplyProvider, ReplyResult } from './reply';
import type { ControlMessage } from '../rtc/client';
import type { RtcStatus } from '../rtc/client';

export type DrivingState = 'idle' | 'recording' | 'thinking' | 'ai';

export interface Turn {
  who: 'user' | 'ai';
  text: string;
  source?: ReplyResult['source'];
}

const WAVE_BARS = 28;
const IDLE_INTENSITIES = Array(WAVE_BARS).fill(0.12);

export interface DrivingLoop {
  state: DrivingState;
  liveText: string;
  lastTurn: Turn | null;
  replySource: ReplyResult['source'] | null;
  intensities: number[];
  error: string | null;
  hasApiKey: boolean;
  daemonConnected: boolean;
  tap: () => void;
  silence: () => void;
}

export interface DrivingLoopOptions {
  replyProvider: ReplyProvider;
  ttsOptions?: TTSOptions;
  getXaiApiKey: () => string;
  sttLanguage?: string;
  // Daemon bridge — required for STT. If absent, tap-to-talk surfaces a
  // `daemon_not_connected` error instead of attempting browser-direct
  // xAI WS (which is blocked — see xaiSocket.ts).
  rtc: {
    status: RtcStatus;
    hasClient: boolean;
    sendControl: (msg: ControlMessage) => void;
    sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
    addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
  };
}

export function useDrivingLoop(opts: DrivingLoopOptions): DrivingLoop {
  const {
    replyProvider,
    ttsOptions,
    getXaiApiKey,
    rtc,
  } = opts;

  const [state, setState] = useState<DrivingState>('idle');
  const [liveText, setLiveText] = useState('');
  const [lastTurn, setLastTurn] = useState<Turn | null>(null);
  const [replySource, setReplySource] = useState<ReplyResult['source'] | null>(null);
  const [intensities, setIntensities] = useState<number[]>(() => [...IDLE_INTENSITIES]);
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean>(() => !!getXaiApiKey().trim());

  const daemonConnected = rtc.hasClient && rtc.status === 'open';

  const sttRef = useRef<STTHandle | null>(null);
  const ttsRef = useRef<TTSHandle | null>(null);
  const liveTextRef = useRef('');
  const replyProviderRef = useRef(replyProvider);
  const ttsOptionsRef = useRef(ttsOptions);
  const getXaiApiKeyRef = useRef(getXaiApiKey);
  const cancelPendingRef = useRef(false);
  const rtcRef = useRef(rtc);

  useEffect(() => {
    replyProviderRef.current = replyProvider;
  }, [replyProvider]);

  useEffect(() => {
    ttsOptionsRef.current = ttsOptions;
  }, [ttsOptions]);

  useEffect(() => {
    getXaiApiKeyRef.current = getXaiApiKey;
  }, [getXaiApiKey]);

  useEffect(() => {
    rtcRef.current = rtc;
  }, [rtc]);

  useEffect(() => {
    liveTextRef.current = liveText;
  }, [liveText]);

  useEffect(() => {
    if (state !== 'idle') return;
    const id = window.setInterval(() => {
      const next = !!getXaiApiKeyRef.current().trim();
      setHasApiKey((prev) => (prev === next ? prev : next));
    }, 500);
    return () => window.clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (state === 'idle') {
      setIntensities([...IDLE_INTENSITIES]);
      return;
    }
    let raf = 0;
    const tick = (t: number) => {
      const base = state === 'thinking' ? 0.22 : 0.55;
      const variance = state === 'thinking' ? 0.07 : 0.4;
      const next = Array.from({ length: WAVE_BARS }, (_, i) => {
        const v =
          base +
          Math.sin(t / 120 + i * 0.8) * variance +
          Math.sin(t / 80 + i * 1.7) * variance * 0.5;
        return Math.max(0.08, Math.min(1, Math.abs(v)));
      });
      setIntensities(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  useEffect(() => {
    return () => {
      sttRef.current?.cancel();
      ttsRef.current?.stop();
    };
  }, []);

  const runReplyAndSpeak = useCallback(async (userText: string) => {
    setReplySource(null);

    let result: ReplyResult;
    try {
      result = await replyProviderRef.current(userText);
    } catch (err) {
      result = {
        text: "Something went wrong reaching the reply provider. Let's try that again.",
        source: 'stub',
        reason: err instanceof Error ? err.message : 'reply_failed',
      };
    }

    setReplySource(result.source);
    setLiveText(result.text);
    setState('ai');

    const apiKey = getXaiApiKeyRef.current().trim();
    const tts = speakWithXaiTTS(result.text, {
      ...(ttsOptionsRef.current || {}),
      apiKey,
    });
    ttsRef.current = tts;
    try {
      await tts.done;
    } finally {
      ttsRef.current = null;
      if (tts.error) setError(tts.error);
      setLastTurn({ who: 'ai', text: result.text, source: result.source });
      setLiveText('');
      setState('idle');
    }
  }, []);

  const tap = useCallback(() => {
    if (state === 'idle') {
      if (!rtcRef.current.hasClient) {
        setError('daemon_not_connected');
        return;
      }
      if (rtcRef.current.status !== 'open') {
        setError('daemon_not_connected');
        return;
      }

      setError(null);
      setLiveText('');
      setReplySource(null);
      setLastTurn(null);
      cancelPendingRef.current = false;
      setState('recording');

      void (async () => {
        try {
          const handle = await startDaemonSTT({
            sendControl: rtcRef.current.sendControl,
            sendBinary: rtcRef.current.sendBinary,
            addControlListener: rtcRef.current.addControlListener,
            isConnected: () => rtcRef.current.status === 'open',
            onPartial: (text, isFinal) => {
              // xAI can emit empty `transcript.partial`s during a
              // silence tail; treat those as non-events so they don't
              // wipe the on-screen live transcript text. A truly final
              // empty result will still surface through transcript.done.
              if (!text && !isFinal) return;
              setLiveText(text);
            },
            onError: (reason) => setError(reason),
          });
          if (cancelPendingRef.current) {
            cancelPendingRef.current = false;
            handle.cancel();
            return;
          }
          sttRef.current = handle;
        } catch (err) {
          const reason =
            err instanceof DaemonNotConnectedError
              ? 'daemon_not_connected'
              : err instanceof MicPermissionError
                ? 'mic_denied'
                : err instanceof Error
                  ? err.message
                  : 'stt_start_failed';
          setError(reason);
          setState('idle');
          sttRef.current = null;
        }
      })();
      return;
    }

    if (state === 'recording') {
      if (!sttRef.current) {
        cancelPendingRef.current = true;
        setState('idle');
        return;
      }
      const handle = sttRef.current;
      sttRef.current = null;
      setLiveText('Transcribing…');
      setState('thinking');

      void (async () => {
        let transcript = '';
        try {
          transcript = await handle.stop();
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'stt_failed';
          setError(reason);
          setLiveText('');
          setState('idle');
          return;
        }
        if (!transcript) {
          setError('empty_transcript');
          setLiveText('');
          setState('idle');
          return;
        }
        setLastTurn({ who: 'user', text: transcript });
        setLiveText('');
        await runReplyAndSpeak(transcript);
      })();
      return;
    }

    if (state === 'ai') {
      ttsRef.current?.stop();
      ttsRef.current = null;
      setLastTurn((prev) =>
        prev && prev.who === 'ai'
          ? prev
          : { who: 'ai', text: liveTextRef.current, source: replySource ?? undefined },
      );
      setLiveText('');
      setState('idle');
      return;
    }
  }, [state, replySource, runReplyAndSpeak]);

  const silence = useCallback(() => {
    if (ttsRef.current) {
      ttsRef.current.stop();
      ttsRef.current = null;
    }
    if (state === 'ai') setState('idle');
  }, [state]);

  return {
    state,
    liveText,
    lastTurn,
    replySource,
    intensities,
    error,
    hasApiKey,
    daemonConnected,
    tap,
    silence,
  };
}
