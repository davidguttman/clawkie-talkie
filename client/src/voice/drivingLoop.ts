// Driving state machine — thin adapter that drives the pure reducer
// in `./drivingReducer.ts` from UI taps + daemon control messages, and
// translates the reducer's side-effect intents into concrete DataChannel
// traffic and audio-player control.
//
// STT, reply generation, and TTS are all owned by the daemon now; the
// browser only ships mic PCM in and plays PCM audio back out. No xAI
// key on this side.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  startDaemonSTT,
  DaemonNotConnectedError,
  MicPermissionError,
  type STTHandle,
} from './sttDaemon';
import {
  playDaemonTts,
  getActiveOutputAnalysers,
  startBackgroundStatic,
  stopBackgroundStatic,
  type TTSHandle,
} from './tts';
import {
  analyserToBandIntensities,
  mergeBandIntensities,
  pcm16ToBandIntensities,
  smoothBandIntensities,
} from './audioBands';
import {
  initialContext,
  reduce,
  type DrivingContext,
  type DrivingEvent,
  type DrivingSideEffect,
  type DrivingState,
} from './drivingReducer';
import type { ControlMessage, RtcStatus } from '../rtc/client';

export type { DrivingState } from './drivingReducer';

export interface Turn {
  who: 'user' | 'ai';
  text: string;
}

interface CurrentTurnTranscript {
  active: boolean;
  sttDone: boolean;
  text: string;
}

const WAVE_BARS = 28;
const IDLE_INTENSITIES = Array(WAVE_BARS).fill(0.12);
const QUIET_INTENSITIES = Array(WAVE_BARS).fill(0.08);

export interface DrivingLoop {
  state: DrivingState;
  liveText: string;
  isTranscribing: boolean;
  lastTurn: Turn | null;
  intensities: number[];
  error: string | null;
  daemonConnected: boolean;
  tap: () => void;
  silence: () => void;
}

export interface DrivingLoopOptions {
  ttsRate?: number;
  sttLanguage?: string;
  sessionId?: string;
  threadId?: string;
  rtc: {
    status: RtcStatus;
    hasClient: boolean;
    sendControl: (msg: ControlMessage) => void;
    sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
    addControlListener: (fn: (msg: ControlMessage) => void) => () => void;
    addBinaryListener: (fn: (bytes: ArrayBuffer) => void) => () => void;
    addRemoteStreamListener?: (fn: (stream: MediaStream) => void) => () => void;
  };
}

function dispatchPair(
  prev: { ctx: DrivingContext; side: DrivingSideEffect[] },
  event: DrivingEvent,
): { ctx: DrivingContext; side: DrivingSideEffect[] } {
  const { next, side } = reduce(prev.ctx, event);
  return { ctx: next, side };
}

export function useDrivingLoop(opts: DrivingLoopOptions): DrivingLoop {
  const { rtc, ttsRate } = opts;

  const [{ ctx, side }, dispatch] = useReducer(dispatchPair, {
    ctx: initialContext,
    side: [] as DrivingSideEffect[],
  });

  const [currentTurnTranscript, setCurrentTurnTranscript] = useState<CurrentTurnTranscript>({
    active: false,
    sttDone: false,
    text: '',
  });
  const [intensities, setIntensities] = useState<number[]>(() => [...IDLE_INTENSITIES]);

  const sttRef = useRef<STTHandle | null>(null);
  const ttsRef = useRef<TTSHandle | null>(null);
  const micBandsRef = useRef<number[]>([...QUIET_INTENSITIES]);
  const renderedBandsRef = useRef<number[]>([...IDLE_INTENSITIES]);
  // Accumulator for non-empty final partials. Used as fallback for
  // `stt.done` when xAI ships an empty final transcript despite having
  // committed real words during the turn.
  const accumulatedRef = useRef<string[]>([]);
  const rtcRef = useRef(rtc);
  useEffect(() => {
    rtcRef.current = rtc;
  }, [rtc]);

  const daemonConnected = rtc.hasClient && rtc.status === 'open';

  // Listen for daemon control messages that drive state transitions.
  useEffect(() => {
    const detach = rtc.addControlListener((msg) => {
      if (msg.t === 'stt.partial') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        // xAI can emit empty partials (and even empty *finals*) during
        // silence tails. Either form would wipe the live caption, so
        // drop them entirely — only commit non-empty text on screen.
        if (!text.trim()) return;
        const isFinal = !!(msg as { is_final?: boolean }).is_final;
        if (isFinal) {
          accumulatedRef.current.push(text.trim());
          setCurrentTurnTranscript({
            active: true,
            sttDone: false,
            text: accumulatedRef.current.join(' ').trim(),
          });
        } else {
          setCurrentTurnTranscript({
            active: true,
            sttDone: false,
            text: composeTranscript(accumulatedRef.current, text),
          });
        }
        return;
      }
      if (msg.t === 'stt.done') {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        const fallback = accumulatedRef.current.join(' ').trim();
        const finalText = text || fallback;
        if (!finalText) {
          accumulatedRef.current = [];
          setCurrentTurnTranscript({ active: false, sttDone: false, text: '' });
          dispatch({ type: 'stt.error', reason: 'empty_transcript' });
          return;
        }
        accumulatedRef.current = [];
        setCurrentTurnTranscript({ active: true, sttDone: true, text: finalText });
        dispatch({ type: 'stt.done', text: finalText });
        return;
      }
      if (msg.t === 'stt.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'stt_error';
        setCurrentTurnTranscript({ active: false, sttDone: false, text: '' });
        dispatch({ type: 'stt.error', reason });
        return;
      }
      if (msg.t === 'reply.done') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        dispatch({ type: 'reply.done', text });
        return;
      }
      if (msg.t === 'reply.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'reply_error';
        dispatch({ type: 'reply.error', reason });
        return;
      }
      if (msg.t === 'tts.done') {
        dispatch({ type: 'tts.done' });
        return;
      }
      if (msg.t === 'tts.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'tts_error';
        dispatch({ type: 'tts.error', reason });
        return;
      }
    });
    return detach;
  }, [rtc]);

  // Perform side-effects produced by the most recent reducer step.
  useEffect(() => {
    if (!side.length) return;
    for (const s of side) {
      if (s.kind === 'startMic') {
        runStartMic(rtcRef, sttRef, micBandsRef, dispatch);
      }
      else if (s.kind === 'stopMic') runStopMic(sttRef);
      else if (s.kind === 'cancelMic') runCancelMic(sttRef);
      else if (s.kind === 'armTts') runArmTts(rtcRef, ttsRef, ttsRate, dispatch);
      else if (s.kind === 'stopTts') runStopTts(ttsRef);
      else if (s.kind === 'cancelReply') runCancelReply(rtcRef, ttsRef);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  // Audio visualization: recording reads the same PCM frames sent to
  // STT; thinking/AI reads analyser nodes from audible static, daemon
  // TTS fallback playback, and any attached WebRTC remote audio stream.
  useEffect(() => {
    if (ctx.state === 'idle') {
      renderedBandsRef.current = [...IDLE_INTENSITIES];
      setIntensities([...IDLE_INTENSITIES]);
      return;
    }
    let raf = 0;
    const analyserScratch = new WeakMap<
      AnalyserNode,
      { frequency: Uint8Array<ArrayBuffer>; time: Uint8Array<ArrayBuffer> }
    >();
    const tick = () => {
      const target = readTargetBands(ctx.state, micBandsRef.current, ttsRef.current, analyserScratch);
      const next = smoothBandIntensities(renderedBandsRef.current, target, {
        attack: ctx.state === 'recording' ? 0.5 : 0.38,
        release: ctx.state === 'recording' ? 0.18 : 0.12,
      });
      renderedBandsRef.current = next;
      setIntensities(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ctx.state]);

  // Background static / crackle while the agent is thinking or
  // speaking. Tied to ctx.state so it stops cleanly the moment the
  // turn ends or the user starts a new recording.
  useEffect(() => {
    if (ctx.state === 'thinking' || ctx.state === 'ai') {
      startBackgroundStatic();
    } else {
      stopBackgroundStatic();
    }
  }, [ctx.state]);

  // Tear down active handles on unmount.
  useEffect(() => {
    return () => {
      sttRef.current?.cancel();
      ttsRef.current?.stop();
      stopBackgroundStatic();
    };
  }, []);

  const tap = useCallback(() => {
    if (ctx.state === 'idle') {
      if (!rtcRef.current.hasClient || rtcRef.current.status !== 'open') {
        // Surface a connection-error without spinning up a turn.
        dispatch({ type: 'stt.error', reason: 'daemon_not_connected' });
        return;
      }
      accumulatedRef.current = [];
      micBandsRef.current = [...QUIET_INTENSITIES];
      setCurrentTurnTranscript({ active: true, sttDone: false, text: '' });
    }
    dispatch({ type: 'tap' });
  }, [ctx.state]);

  const silence = useCallback(() => {
    dispatch({ type: 'silence' });
  }, []);

  const lastTurn: Turn | null =
    ctx.state === 'idle' && ctx.lastReplyText
      ? { who: 'ai', text: ctx.lastReplyText }
      : ctx.state === 'idle' && ctx.lastUserText
        ? { who: 'user', text: ctx.lastUserText }
        : null;

  const liveCaption = displayedCaptionText(ctx, currentTurnTranscript.text);

  return {
    state: ctx.state,
    liveText: liveCaption,
    isTranscribing: isCurrentTurnTranscribing(ctx.state, currentTurnTranscript),
    lastTurn,
    intensities,
    error: ctx.error,
    daemonConnected,
    tap,
    silence,
  };
}

// --- side-effect runners -----------------------------------------------------

type Dispatch = (e: DrivingEvent) => void;

function runStartMic(
  rtcRef: React.MutableRefObject<DrivingLoopOptions['rtc']>,
  sttRef: React.MutableRefObject<STTHandle | null>,
  micBandsRef: React.MutableRefObject<number[]>,
  dispatch: Dispatch,
): void {
  void (async () => {
    try {
      micBandsRef.current = [...QUIET_INTENSITIES];
      const handle = await startDaemonSTT({
        sendControl: rtcRef.current.sendControl,
        sendBinary: rtcRef.current.sendBinary,
        addControlListener: rtcRef.current.addControlListener,
        isConnected: () => rtcRef.current.status === 'open',
        onError: (reason) => dispatch({ type: 'stt.error', reason }),
        onAudioFrame: (pcm) => {
          micBandsRef.current = pcm16ToBandIntensities(pcm, WAVE_BARS);
        },
      });
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
      dispatch({ type: 'stt.error', reason });
    }
  })();
}

function runStopMic(sttRef: React.MutableRefObject<STTHandle | null>): void {
  const handle = sttRef.current;
  sttRef.current = null;
  if (!handle) return;
  // stop() resolves with the final transcript. We don't need the value
  // here — the daemon will emit `stt.done` on the control channel, and
  // the listener above will turn that into an `stt.done` reducer event.
  handle.stop().catch(() => {
    // swallow — any real error will surface via stt.error on the wire
  });
}

function runCancelMic(sttRef: React.MutableRefObject<STTHandle | null>): void {
  const handle = sttRef.current;
  sttRef.current = null;
  handle?.cancel();
}

function runArmTts(
  rtcRef: React.MutableRefObject<DrivingLoopOptions['rtc']>,
  ttsRef: React.MutableRefObject<TTSHandle | null>,
  rate: number | undefined,
  dispatch: Dispatch,
): void {
  const tts = playDaemonTts({
    addControlListener: rtcRef.current.addControlListener,
    addBinaryListener: rtcRef.current.addBinaryListener,
    sendControl: rtcRef.current.sendControl,
    rate,
  });
  ttsRef.current = tts;
  void tts.done.then(() => {
    if (ttsRef.current !== tts) return;
    ttsRef.current = null;
    if (tts.error) dispatch({ type: 'tts.error', reason: tts.error });
  });
}

function runStopTts(ttsRef: React.MutableRefObject<TTSHandle | null>): void {
  const tts = ttsRef.current;
  ttsRef.current = null;
  tts?.stop();
}

function runCancelReply(
  rtcRef: React.MutableRefObject<DrivingLoopOptions['rtc']>,
  ttsRef: React.MutableRefObject<TTSHandle | null>,
): void {
  try {
    rtcRef.current.sendControl({ t: 'reply.cancel' });
  } catch {
    // ignore
  }
  const tts = ttsRef.current;
  ttsRef.current = null;
  tts?.stop();
}

function readTargetBands(
  state: DrivingState,
  micBands: number[],
  tts: TTSHandle | null,
  analyserScratch: WeakMap<
    AnalyserNode,
    { frequency: Uint8Array<ArrayBuffer>; time: Uint8Array<ArrayBuffer> }
  >,
): number[] {
  if (state === 'recording') return micBands;
  if (state !== 'thinking' && state !== 'ai') return QUIET_INTENSITIES;

  const analysers = getActiveOutputAnalysers();
  if (tts?.analyser) analysers.push(tts.analyser);
  if (analysers.length === 0) return QUIET_INTENSITIES;

  const bands = analysers.map((analyser) => {
    let scratch = analyserScratch.get(analyser);
    if (
      !scratch ||
      scratch.frequency.length !== analyser.frequencyBinCount ||
      scratch.time.length !== analyser.fftSize
    ) {
      scratch = {
        frequency: new Uint8Array(analyser.frequencyBinCount),
        time: new Uint8Array(analyser.fftSize),
      };
      analyserScratch.set(analyser, scratch);
    }
    return analyserToBandIntensities(analyser, WAVE_BARS, scratch.frequency, scratch.time);
  });
  return mergeBandIntensities(bands, WAVE_BARS);
}

export function displayedCaptionText(ctx: DrivingContext, liveText: string): string {
  if (ctx.state === 'ai') return ctx.liveReplyText;
  if (ctx.state === 'thinking') return liveText;
  return liveText;
}

export function isCurrentTurnTranscribing(
  state: DrivingState,
  transcript: Pick<CurrentTurnTranscript, 'active' | 'sttDone'>,
): boolean {
  return state === 'thinking' && transcript.active && !transcript.sttDone;
}

export function composeTranscript(finals: string[], current: string): string {
  return [...finals, current.trim()].filter(Boolean).join(' ').trim();
}
