// Driving state machine.
//
// IDLE → REC → THINK → AI → IDLE, ported from docs/design/hifi-driving.jsx.
// REC captures mic audio via MediaRecorder; tap-stop uploads the blob to
// xAI STT (the only transcription path — no browser-side fallback). THINK
// covers both transcription and reply generation; AI is TTS playback.
//
// The daemon/WebRTC transport phase will replace `replyProvider` and the
// STT call with DataChannel-backed variants; the hook contract stays the
// same.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startXaiSTT,
  MissingApiKeyError,
  MicPermissionError,
  type STTHandle,
} from './stt';
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
  hasApiKey: boolean;
  tap: () => void;
  silence: () => void;
}

export function useDrivingLoop(opts: {
  replyProvider: ReplyProvider;
  ttsOptions?: TTSOptions;
  // Read fresh at call time so Settings edits take effect on the next turn
  // without re-mounting the hook.
  getSttApiKey: () => string;
  sttLanguage?: string;
}): DrivingLoop {
  const { replyProvider, ttsOptions, getSttApiKey, sttLanguage } = opts;

  const [state, setState] = useState<DrivingState>('idle');
  const [liveText, setLiveText] = useState('');
  const [lastTurn, setLastTurn] = useState<Turn | null>(null);
  const [replySource, setReplySource] = useState<ReplyResult['source'] | null>(null);
  const [intensities, setIntensities] = useState<number[]>(() => [...IDLE_INTENSITIES]);
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean>(() => !!getSttApiKey().trim());

  const sttRef = useRef<STTHandle | null>(null);
  const ttsRef = useRef<TTSHandle | null>(null);
  const liveTextRef = useRef('');
  const replyProviderRef = useRef(replyProvider);
  const ttsOptionsRef = useRef(ttsOptions);
  const getSttApiKeyRef = useRef(getSttApiKey);
  const sttLanguageRef = useRef(sttLanguage);
  // Set if the user taps stop before the mic stream has finished opening —
  // the pending acquisition discards its handle instead of publishing it.
  const cancelPendingRef = useRef(false);

  useEffect(() => {
    replyProviderRef.current = replyProvider;
  }, [replyProvider]);

  useEffect(() => {
    ttsOptionsRef.current = ttsOptions;
  }, [ttsOptions]);

  useEffect(() => {
    getSttApiKeyRef.current = getSttApiKey;
  }, [getSttApiKey]);

  useEffect(() => {
    sttLanguageRef.current = sttLanguage;
  }, [sttLanguage]);

  useEffect(() => {
    liveTextRef.current = liveText;
  }, [liveText]);

  // Keep hasApiKey in sync with whatever the getter reports. Cheap to poll
  // while idle; gives the UI a reactive blocker hint without needing to
  // observe localStorage changes across tabs.
  useEffect(() => {
    if (state !== 'idle') return;
    const id = window.setInterval(() => {
      const next = !!getSttApiKeyRef.current().trim();
      setHasApiKey((prev) => (prev === next ? prev : next));
    }, 500);
    return () => window.clearInterval(id);
  }, [state]);

  // Wave animation — synthetic pattern that visibly differs between
  // recording (wide swings) and thinking (narrow swings).
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
      const apiKey = getSttApiKeyRef.current().trim();
      if (!apiKey) {
        setError('missing_xai_api_key');
        setHasApiKey(false);
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
          const handle = await startXaiSTT({
            apiKey,
            language: sttLanguageRef.current,
          });
          if (cancelPendingRef.current) {
            cancelPendingRef.current = false;
            handle.cancel();
            return;
          }
          sttRef.current = handle;
        } catch (err) {
          const reason =
            err instanceof MissingApiKeyError
              ? 'missing_xai_api_key'
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
        // Still acquiring mic — bail out of the acquisition path and
        // return to idle. The in-flight start() will discard its handle.
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
      // Silence: kill playback, return to idle. Keep the AI turn record so
      // the caption can still show what was said.
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

    // THINK state: no-op; user can't interrupt xAI mid-request in this slice.
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
    tap,
    silence,
  };
}
