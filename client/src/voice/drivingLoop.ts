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
  type TTSHandle,
} from './tts';
import {
  analyserToBandIntensities,
  BandNormalizer,
  mergeBandIntensities,
  pcm16ToBandIntensities,
  smoothBandIntensities,
} from './audioBands';
import { getActiveMicAnalyser } from './audioSource';
import {
  initialContext,
  RECONNECT_AUTO_RESUME_THRESHOLD_MS,
  reduce,
  type DrivingContext,
  type DrivingEvent,
  type DrivingHydration,
  type DrivingReplayEvent,
  type DrivingSideEffect,
  type DrivingState,
} from './drivingReducer';
import { HoldMusicController, getActiveHoldMusicAnalyser } from './holdMusic';
import type { ControlMessage, RtcStatus } from '../rtc/client';
import { appendTranscriptTurn } from '../storage';

export type { DrivingState } from './drivingReducer';

export interface Turn {
  who: 'user' | 'ai';
  text: string;
}

export interface CurrentTurnTranscript {
  active: boolean;
  sttDone: boolean;
  text: string;
}

const WAVE_BARS = 28;
const UNIQUE_WAVE_BANDS = WAVE_BARS / 2;
const IDLE_INTENSITIES = Array(WAVE_BARS).fill(0.12);
const QUIET_INTENSITIES = Array(WAVE_BARS).fill(0.08);
const LIGHT_SMOOTHING = { attack: 0.85, release: 0.6 } as const;

export interface AnalyserScratch {
  frequency: Uint8Array<ArrayBuffer>;
  time: Uint8Array<ArrayBuffer>;
  normalizer: BandNormalizer;
}

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
  sttLanguage?: string;
  sessionId?: string;
  threadId?: string;
  hostPeerId?: string | null;
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
  const { rtc } = opts;

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
  const holdMusicRef = useRef<HoldMusicController | null>(null);
  const micBandsRef = useRef<number[]>([...QUIET_INTENSITIES]);
  const renderedBandsRef = useRef<number[]>([...IDLE_INTENSITIES]);
  // Accumulator for committed VAD/STT chunks. These drive the live caption
  // only; the full-turn `stt.done` transcript remains authoritative.
  const accumulatedRef = useRef<string[]>([]);
  const rtcRef = useRef(rtc);
  const sessionMetaRef = useRef({
    sessionId: opts.sessionId,
    threadId: opts.threadId,
    hostPeerId: opts.hostPeerId,
  });
  useEffect(() => {
    rtcRef.current = rtc;
  }, [rtc]);
  useEffect(() => {
    sessionMetaRef.current = {
      sessionId: opts.sessionId,
      threadId: opts.threadId,
      hostPeerId: opts.hostPeerId,
    };
  }, [opts.sessionId, opts.threadId, opts.hostPeerId]);

  const daemonConnected = rtc.hasClient && rtc.status === 'open';

  // Listen for daemon control messages that drive state transitions.
  useEffect(() => {
    const detach = rtc.addControlListener((msg) => {
      if (msg.t === 'session.snapshot') {
        const plan = sessionSnapshotReplayPlanFromControlMessage(msg);
        if (plan) {
          for (const event of sessionSnapshotControlEvents(msg)) {
            applyReplayControlSideEffects(event, sessionMetaRef.current, holdMusicRef.current);
          }
          if (plan.transcript) {
            accumulatedRef.current = [];
            setCurrentTurnTranscript(plan.transcript);
          }
          dispatch(plan.event);
        }
        return;
      }
      if (msg.t === 'stt.partial') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        // Some STT providers can emit empty partials (and even empty
        // *finals*) during silence tails. Either form would wipe the
        // live caption, so drop them entirely — only commit non-empty
        // text on screen.
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
        const result = resolveSttDone(msg.text, accumulatedRef.current);
        accumulatedRef.current = result.nextAccumulated;
        setCurrentTurnTranscript(result.transcript);
        if ('saveText' in result) saveTranscriptTurn(sessionMetaRef.current, 'user', result.saveText);
        dispatch(result.event);
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
        saveTranscriptTurn(sessionMetaRef.current, 'assistant', text);
        dispatch({ type: 'reply.done', text });
        return;
      }
      if (msg.t === 'reply.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'reply_error';
        saveTranscriptTurn(sessionMetaRef.current, 'assistant', '', reason);
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
        dispatch({ type: 'reply.error', reason });
        return;
      }
      if (msg.t === 'tts.start') {
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
        dispatch({ type: 'tts.start' });
        return;
      }
      if (msg.t === 'tts.done') {
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
        dispatch({ type: 'tts.done' });
        return;
      }
      if (msg.t === 'tts.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'tts_error';
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
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
      else if (s.kind === 'armTts') runArmTts(rtcRef, ttsRef, dispatch);
      else if (s.kind === 'stopTts') runStopTts(ttsRef);
      else if (s.kind === 'cancelReply') runCancelReply(rtcRef, ttsRef);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  useEffect(() => {
    if (ctx.state === 'thinking') {
      holdMusicRef.current ??= new HoldMusicController();
    }
    syncHoldMusicForDrivingState(ctx.state, holdMusicRef.current);
  }, [ctx.state]);

  // Audio visualization: recording samples the live mic analyser every
  // RAF; STT PCM frames remain only as the daemon transport and as a
  // short fallback before the analyser exists. Thinking/AI reads
  // analyser nodes from daemon TTS fallback playback and any attached
  // WebRTC remote audio stream.
  useEffect(() => {
    if (ctx.state === 'idle') {
      renderedBandsRef.current = [...IDLE_INTENSITIES];
      setIntensities([...IDLE_INTENSITIES]);
      return;
    }
    let raf = 0;
    const analyserScratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const tick = () => {
      const target = readTargetBands(ctx.state, micBandsRef.current, ttsRef.current, analyserScratch);
      const smoothed = smoothBandIntensities(renderedBandsRef.current, target, LIGHT_SMOOTHING);
      renderedBandsRef.current = smoothed;
      setIntensities(smoothed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ctx.state]);

  // Tear down active handles on unmount.
  useEffect(() => {
    return () => {
      sttRef.current?.cancel();
      ttsRef.current?.stop();
      holdMusicRef.current?.stop();
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
    holdMusicRef.current ??= new HoldMusicController();
    void holdMusicRef.current.unlock();
    dispatch({
      type: 'tap',
      currentTurnTranscribing: isCurrentTurnTranscribing(ctx.state, currentTurnTranscript),
    });
  }, [ctx.state, currentTurnTranscript]);

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
          micBandsRef.current = mirrorCenterOutBands(
            pcm16ToBandIntensities(pcm, UNIQUE_WAVE_BANDS),
          );
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
  dispatch: Dispatch,
): void {
  const tts = playDaemonTts({
    addControlListener: rtcRef.current.addControlListener,
    addBinaryListener: rtcRef.current.addBinaryListener,
    sendControl: rtcRef.current.sendControl,
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

function saveTranscriptTurn(
  opts: Pick<DrivingLoopOptions, 'sessionId' | 'threadId' | 'hostPeerId'>,
  role: 'user' | 'assistant',
  text: string,
  error?: string,
): void {
  if (!opts.sessionId) return;
  appendTranscriptTurn(
    {
      sessionId: opts.sessionId,
      threadId: opts.threadId,
      hostPeerId: opts.hostPeerId,
    },
    { role, text, error },
  );
}

export type SttDoneResolution =
  | {
      nextAccumulated: string[];
      transcript: CurrentTurnTranscript;
      event: Extract<DrivingEvent, { type: 'stt.error' }>;
    }
  | {
      nextAccumulated: string[];
      transcript: CurrentTurnTranscript;
      event: Extract<DrivingEvent, { type: 'stt.done' }>;
      saveText: string;
    };

export function resolveSttDone(
  msgText: unknown,
  _committedChunks: readonly string[] = [],
): SttDoneResolution {
  const finalText = typeof msgText === 'string' ? msgText.trim() : '';
  if (!finalText) {
    return {
      nextAccumulated: [],
      transcript: { active: false, sttDone: false, text: '' },
      event: { type: 'stt.error', reason: 'empty_transcript' },
    };
  }
  return {
    nextAccumulated: [],
    transcript: { active: true, sttDone: true, text: finalText },
    event: { type: 'stt.done', text: finalText },
    saveText: finalText,
  };
}

export interface SessionSnapshotReplayPlan {
  event: Extract<DrivingEvent, { type: 'session.replay' }>;
  transcript: CurrentTurnTranscript | null;
}

interface SnapshotHydrationPlan {
  hydration: DrivingHydration;
  transcript: CurrentTurnTranscript;
}

export function sessionSnapshotReplayPlanFromControlMessage(
  msg: ControlMessage,
): SessionSnapshotReplayPlan | null {
  if (msg.t !== 'session.snapshot') return null;
  const events = sessionSnapshotControlEvents(msg)
    .map(drivingReplayEventFromControlMessage)
    .filter((event): event is DrivingReplayEvent => !!event);
  const snapshot = sessionSnapshotRecord(msg);
  const hydrated = snapshot ? snapshotHydrationPlan(snapshot) : null;
  if (!hydrated && events.length === 0) return null;
  return {
    event: {
      type: 'session.replay',
      events,
      ...(hydrated ? { hydration: hydrated.hydration } : {}),
    },
    transcript: hydrated?.transcript ?? null,
  };
}

export function sessionSnapshotControlEvents(msg: ControlMessage): ControlMessage[] {
  const events = Array.isArray(msg.events) ? msg.events : [];
  return events
    .filter((event): event is Record<string, unknown> => {
      return !!event && typeof event === 'object' && !Array.isArray(event) && typeof event.t === 'string';
    })
    .map((event) => event as ControlMessage);
}

export function drivingReplayEventFromControlMessage(msg: ControlMessage): DrivingReplayEvent | null {
  if (msg.t === 'stt.done') return resolveSttDone(msg.text).event;
  if (msg.t === 'stt.error') {
    return { type: 'stt.error', reason: typeof msg.message === 'string' ? msg.message : 'stt_error' };
  }
  if (msg.t === 'reply.done') {
    return { type: 'reply.done', text: typeof msg.text === 'string' ? msg.text : '' };
  }
  if (msg.t === 'reply.error') {
    return { type: 'reply.error', reason: typeof msg.message === 'string' ? msg.message : 'reply_error' };
  }
  if (msg.t === 'tts.start') return { type: 'tts.start' };
  if (msg.t === 'tts.done') return { type: 'tts.done' };
  if (msg.t === 'tts.error') {
    return { type: 'tts.error', reason: typeof msg.message === 'string' ? msg.message : 'tts_error' };
  }
  return null;
}

function sessionSnapshotRecord(msg: ControlMessage): Record<string, unknown> | null {
  const message = objectRecord(msg) ?? {};
  const nestedSnapshot = objectRecord(message.snapshot);
  const nestedTurn = objectRecord(nestedSnapshot?.turn) ?? objectRecord(message.turn);
  const merged = {
    ...message,
    ...(nestedSnapshot ?? {}),
    ...(nestedTurn ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

function snapshotHydrationPlan(source: Record<string, unknown>): SnapshotHydrationPlan | null {
  const phase = normalizeSnapshotPhase(
    firstString(source, ['phase', 'turnPhase', 'status', 'state']),
    source,
  );
  const lastUserText = firstString(source, [
    'lastUserText',
    'userText',
    'transcript',
    'finalTranscript',
    'promptText',
  ]);
  const replyText = firstString(source, [
    'lastReplyText',
    'replyText',
    'assistantText',
    'responseText',
    'pendingReplyText',
  ]);
  const pendingReplyText = firstString(source, [
    'pendingReplyText',
    'pendingReply',
    'replyText',
    'assistantText',
    'responseText',
  ]);
  const error = firstString(source, ['error', 'reason', 'message']) || null;
  const disconnectedMs = numberValue(source.disconnectedMs);
  const canAutoResume = disconnectedMs === undefined || disconnectedMs <= RECONNECT_AUTO_RESUME_THRESHOLD_MS;

  if (!phase) return null;

  if (phase === 'completed') {
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'idle',
          lastUserText,
          lastReplyText: replyText,
        },
        armTts: false,
      },
      transcript: { active: false, sttDone: false, text: '' },
    };
  }

  if (phase === 'reply-ready') {
    if (!canAutoResume) {
      return {
        hydration: {
          context: {
            ...initialContext,
            state: 'idle',
            lastUserText,
            lastReplyText: pendingReplyText,
          },
          armTts: false,
        },
        transcript: { active: false, sttDone: false, text: '' },
      };
    }
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'thinking',
          lastUserText,
          pendingReplyText,
        },
        armTts: !!pendingReplyText,
      },
      transcript: { active: !!lastUserText, sttDone: true, text: lastUserText },
    };
  }

  if (phase === 'speaking') {
    if (!canAutoResume) {
      return {
        hydration: {
          context: {
            ...initialContext,
            state: 'idle',
            lastUserText,
            lastReplyText: replyText,
          },
          armTts: false,
        },
        transcript: { active: false, sttDone: false, text: '' },
      };
    }
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'ai',
          lastUserText,
          lastReplyText: replyText,
          liveReplyText: replyText,
        },
        armTts: !!replyText,
      },
      transcript: { active: !!lastUserText, sttDone: true, text: lastUserText },
    };
  }

  if (phase === 'error') {
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'idle',
          lastUserText,
          lastReplyText: replyText,
          error,
        },
        armTts: false,
      },
      transcript: { active: false, sttDone: false, text: '' },
    };
  }

  if (phase === 'thinking') {
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'thinking',
          lastUserText,
        },
        armTts: false,
      },
      transcript: { active: !!lastUserText, sttDone: true, text: lastUserText },
    };
  }

  if (phase === 'recording') {
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'recording',
          lastUserText,
        },
        armTts: false,
      },
      transcript: { active: true, sttDone: false, text: lastUserText },
    };
  }

  return {
    hydration: {
      context: {
        ...initialContext,
        state: 'idle',
        lastUserText,
        lastReplyText: replyText,
      },
      armTts: false,
    },
    transcript: { active: false, sttDone: false, text: '' },
  };
}

type SnapshotPhase = 'idle' | 'recording' | 'thinking' | 'reply-ready' | 'speaking' | 'completed' | 'error';

function normalizeSnapshotPhase(
  raw: string,
  source: Record<string, unknown>,
): SnapshotPhase | null {
  const value = raw.trim().toLowerCase().replace(/[ _]+/g, '-');
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed';
  if (value === 'reply-ready' || value === 'replyready' || value === 'reply-done') return 'reply-ready';
  if (value === 'speaking' || value === 'ai' || value === 'tts' || value === 'tts-started') return 'speaking';
  if (value === 'error' || value === 'failed') return 'error';
  if (value === 'thinking' || value === 'replying' || value === 'generating') return 'thinking';
  if (value === 'recording' || value === 'listening' || value === 'stt') return 'recording';
  if (value === 'idle') {
    return firstString(source, ['lastReplyText', 'replyText', 'assistantText', 'responseText'])
      ? 'completed'
      : 'idle';
  }
  if (source.error || source.reason) return 'error';
  if (firstString(source, ['lastReplyText', 'replyText', 'assistantText', 'responseText'])) return 'completed';
  if (firstString(source, ['lastUserText', 'userText', 'transcript', 'finalTranscript'])) return 'thinking';
  return null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}


function applyReplayControlSideEffects(
  msg: ControlMessage,
  sessionMeta: Pick<DrivingLoopOptions, 'sessionId' | 'threadId' | 'hostPeerId'>,
  holdMusic: HoldMusicLike | null,
): void {
  if (msg.t === 'stt.done') {
    const result = resolveSttDone(msg.text);
    if ('saveText' in result) saveTranscriptTurn(sessionMeta, 'user', result.saveText);
    return;
  }
  if (msg.t === 'reply.done') {
    saveTranscriptTurn(sessionMeta, 'assistant', typeof msg.text === 'string' ? msg.text : '');
    return;
  }
  if (msg.t === 'reply.error') {
    const reason = typeof msg.message === 'string' ? msg.message : 'reply_error';
    saveTranscriptTurn(sessionMeta, 'assistant', '', reason);
    stopHoldMusicForControlMessage(msg, holdMusic);
    return;
  }
  if (msg.t === 'tts.start' || msg.t === 'tts.done' || msg.t === 'tts.error') {
    stopHoldMusicForControlMessage(msg, holdMusic);
  }
}

export function readTargetBands(
  state: DrivingState,
  micBands: number[],
  tts: TTSHandle | null,
  analyserScratch: WeakMap<AnalyserNode, AnalyserScratch>,
): number[] {
  if (state === 'recording') {
    const micAnalyser = getActiveMicAnalyser();
    return micAnalyser ? readAnalyserBands(micAnalyser, analyserScratch) : micBands;
  }
  if (state !== 'thinking' && state !== 'ai') return QUIET_INTENSITIES;

  const analysers = getActiveOutputAnalysers();
  if (tts?.analyser) analysers.push(tts.analyser);
  if (state === 'thinking') {
    const holdAnalyser = getActiveHoldMusicAnalyser();
    if (holdAnalyser) analysers.push(holdAnalyser);
  }
  if (analysers.length === 0) return QUIET_INTENSITIES;

  const bands = analysers.map((analyser) => readAnalyserBands(analyser, analyserScratch));
  return mergeBandIntensities(bands, WAVE_BARS);
}

function readAnalyserBands(
  analyser: AnalyserNode,
  analyserScratch: WeakMap<AnalyserNode, AnalyserScratch>,
): number[] {
  let scratch = analyserScratch.get(analyser);
  if (
    !scratch ||
    scratch.frequency.length !== analyser.frequencyBinCount ||
    scratch.time.length !== analyser.fftSize
  ) {
    scratch = {
      frequency: new Uint8Array(analyser.frequencyBinCount),
      time: new Uint8Array(analyser.fftSize),
      normalizer: new BandNormalizer(),
    };
    analyserScratch.set(analyser, scratch);
  }
  return mirrorCenterOutBands(
    analyserToBandIntensities(
      analyser,
      UNIQUE_WAVE_BANDS,
      scratch.frequency,
      scratch.time,
      scratch.normalizer,
    ),
  );
}

// Mirrors low-to-high `uniqueBands` so the highest frequencies render on the
// outside edges and the lowest frequencies render at the center.
// e.g. [low, mid, high] => [high, mid, low, low, mid, high].
export function mirrorCenterOutBands(uniqueBands: readonly number[]): number[] {
  return [...uniqueBands.slice().reverse(), ...uniqueBands];
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

interface HoldMusicLike {
  start(): void;
  stop(): void;
}

export function syncHoldMusicForDrivingState(
  state: DrivingState,
  holdMusic: HoldMusicLike | null,
): void {
  if (!holdMusic) return;
  if (state === 'thinking') {
    holdMusic.start();
    return;
  }
  if (state === 'idle' || state === 'recording') {
    holdMusic.stop();
  }
}

export function shouldStopHoldMusicForControlMessage(msg: { t: string }): boolean {
  return (
    msg.t === 'reply.error' ||
    msg.t === 'tts.start' ||
    msg.t === 'tts.done' ||
    msg.t === 'tts.error'
  );
}

function stopHoldMusicForControlMessage(
  msg: { t: string },
  holdMusic: HoldMusicLike | null,
): void {
  if (shouldStopHoldMusicForControlMessage(msg)) holdMusic?.stop();
}
