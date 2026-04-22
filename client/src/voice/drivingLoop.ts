// Driving state machine.
//
// Ports the IDLE → REC → THINK → AI → IDLE flow from
// docs/design/hifi-driving.jsx, swapping the scripted `streamText` for a
// live STT handle and the browser SpeechSynthesis fallback for a pluggable
// TTS handle driven by the real reply provider.
//
// The shape here is what the daemon/WebRTC transport will plug into in a
// later phase: `replyProvider` becomes DataChannel-backed, `startBrowserSTT`
// becomes a daemon-forwarded stream. The hook itself doesn't change.

import { useCallback, useEffect, useRef, useState } from 'react';
import { startBrowserSTT, isSTTSupported, type STTHandle } from './stt';
import { speakWithBrowserTTS, type TTSHandle, type TTSOptions } from './tts';
import type { ReplyProvider, ReplyResult } from './reply';

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
  sttSupported: boolean;
  tap: () => void;
  silence: () => void;
}

export function useDrivingLoop(opts: {
  replyProvider: ReplyProvider;
  ttsOptions?: TTSOptions;
}): DrivingLoop {
  const { replyProvider, ttsOptions } = opts;

  const [state, setState] = useState<DrivingState>('idle');
  const [liveText, setLiveText] = useState('');
  const [lastTurn, setLastTurn] = useState<Turn | null>(null);
  const [replySource, setReplySource] = useState<ReplyResult['source'] | null>(null);
  const [intensities, setIntensities] = useState<number[]>(() => [...IDLE_INTENSITIES]);
  const [error, setError] = useState<string | null>(null);

  const sttRef = useRef<STTHandle | null>(null);
  const ttsRef = useRef<TTSHandle | null>(null);
  const liveTextRef = useRef('');
  const replyProviderRef = useRef(replyProvider);
  const ttsOptionsRef = useRef(ttsOptions);

  useEffect(() => {
    replyProviderRef.current = replyProvider;
  }, [replyProvider]);

  useEffect(() => {
    ttsOptionsRef.current = ttsOptions;
  }, [ttsOptions]);

  useEffect(() => {
    liveTextRef.current = liveText;
  }, [liveText]);

  // Wave animation: the idle screen already drifts its own bars; while the
  // loop is active we drive them from a synthetic pattern that visibly
  // differs between recording (wide swings) and thinking (narrow swings).
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

  // Safety net: on unmount, tear down any in-flight recognizer/utterance.
  useEffect(() => {
    return () => {
      sttRef.current?.cancel();
      ttsRef.current?.stop();
    };
  }, []);

  const runReplyAndSpeak = useCallback(async (userText: string) => {
    setState('thinking');
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

    const tts = speakWithBrowserTTS(result.text, ttsOptionsRef.current || {});
    ttsRef.current = tts;
    try {
      await tts.done;
    } finally {
      ttsRef.current = null;
      setLastTurn({ who: 'ai', text: result.text, source: result.source });
      setLiveText('');
      setState('idle');
    }
  }, []);

  const tap = useCallback(() => {
    if (state === 'idle') {
      if (!isSTTSupported()) {
        setError('stt_unsupported');
        return;
      }
      setError(null);
      setLiveText('');
      setReplySource(null);
      setLastTurn(null);
      setState('recording');
      sttRef.current = startBrowserSTT({
        onPartial: (text) => setLiveText(text),
        // We ignore onFinal after stop — the tap-stop path reads liveText
        // directly so the audible reply fires without waiting on the
        // recognizer's internal end-of-stream handshake.
        onFinal: () => {},
        onError: (reason) => {
          setError(reason);
          sttRef.current = null;
          setState('idle');
        },
      });
      return;
    }

    if (state === 'recording') {
      const finalText = liveTextRef.current.trim();
      // Cancel without waiting for the recognizer's async finalize path so
      // the THINK→AI transition starts immediately.
      sttRef.current?.cancel();
      sttRef.current = null;
      setLastTurn({ who: 'user', text: finalText });
      setLiveText('');
      void runReplyAndSpeak(finalText);
      return;
    }

    if (state === 'ai') {
      // Tap during AI = silence: kill playback, return to idle but keep
      // the turn record so the caption can still show what was said.
      ttsRef.current?.stop();
      ttsRef.current = null;
      setLastTurn((prev) =>
        prev && prev.who === 'ai' ? prev : { who: 'ai', text: liveTextRef.current, source: replySource ?? undefined },
      );
      setLiveText('');
      setState('idle');
      return;
    }

    // THINK state: no-op; user can't cancel mid-request in this slice.
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
    sttSupported: isSTTSupported(),
    tap,
    silence,
  };
}
