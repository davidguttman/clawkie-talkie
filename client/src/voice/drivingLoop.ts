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
  reduce,
  type DrivingContext,
  type DrivingEvent,
  type DrivingHydration,
  type DrivingReplayEvent,
  type DrivingSideEffect,
  type DrivingState,
} from './drivingReducer';
import { HoldMusicController, getActiveHoldMusicAnalyser, getHoldMusicMuted } from './holdMusic';
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
  const pendingSttStartRef = useRef<PendingSttStart | null>(null);
  const localSttStopInFlightRef = useRef(false);
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

  useEffect(() => {
    accumulatedRef.current = [];
    setCurrentTurnTranscript({ active: false, sttDone: false, text: '' });
    runCancelMic(sttRef, pendingSttStartRef, localSttStopInFlightRef);
    runStopTts(ttsRef);
    dispatch({ type: 'session.reset' });
  }, [opts.sessionId, opts.threadId, opts.hostPeerId]);

  const daemonConnected = rtc.hasClient && rtc.status === 'open';

  // Listen for daemon control messages that drive state transitions.
  useEffect(() => {
    const detach = rtc.addControlListener((msg) => {
      if (msg.t === 'session.snapshot') {
        const replayControls = sessionSnapshotControlEvents(msg);
        const activeTts = ttsRef.current;
        const handleActiveTtsControl = activeTts?.handleControlMessage;
        const canForwardActiveTts = typeof handleActiveTtsControl === 'function';
        const deferTtsDone = canForwardActiveTts && replayControls.some((event) => event.t === 'tts.done');
        const deferTtsError = canForwardActiveTts && replayControls.some((event) => event.t === 'tts.error');
        if (canForwardActiveTts && (deferTtsDone || deferTtsError)) {
          for (const event of replayControls) {
            if (event.t === 'tts.done' || event.t === 'tts.error') handleActiveTtsControl(event);
          }
        }
        const plan = sessionSnapshotReplayPlanFromControlMessage(msg, { deferTtsDone, deferTtsError });
        if (plan) {
          if (replayControls.some(isSttTerminalControlMessage)) {
            localSttStopInFlightRef.current = false;
          }
          if (hasActiveLocalSttLifecycle(sttRef, pendingSttStartRef, localSttStopInFlightRef) && shouldPreserveActiveLocalSttSnapshot(msg, plan)) {
            // Same-tab reconnects can replay the daemon's in-progress STT
            // snapshot while this browser still owns the live mic handle. The
            // pure cold-launch hydration intentionally maps that snapshot to
            // idle, but doing so here would hide the push-to-stop UI and leak
            // the handle. Keep the local recording lifecycle authoritative.
            return;
          }
          if (hasActiveLocalSttLifecycle(sttRef, pendingSttStartRef, localSttStopInFlightRef) && shouldDiscardLocalSttForSnapshotReplay(plan)) {
            // Any non-bare STT snapshot is now daemon catch-up, not proof that
            // this tab's local mic lifecycle is still authoritative. Drop the
            // pending/active handle before replay/hydration moves the UI away
            // from recording, otherwise a late start can install a hidden mic
            // or an active handle can survive behind idle/thinking UI.
            runCancelMic(sttRef, pendingSttStartRef, localSttStopInFlightRef);
          }
          for (const event of replayControls) {
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
        localSttStopInFlightRef.current = false;
        const result = resolveSttDone(msg.text, accumulatedRef.current);
        accumulatedRef.current = result.nextAccumulated;
        setCurrentTurnTranscript(result.transcript);
        if ('saveText' in result) saveTranscriptTurn(sessionMetaRef.current, 'user', result.saveText);
        dispatch(result.event);
        return;
      }
      if (msg.t === 'stt.error') {
        localSttStopInFlightRef.current = false;
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
        if (msg.buffered === true && !ttsRef.current) {
          runArmTts(rtcRef, ttsRef, dispatch, msg);
        }
        dispatch({
          type: 'tts.start',
          ...(typeof msg.text === 'string' && msg.text.trim() ? { text: msg.text.trim() } : {}),
        });
        return;
      }
      if (msg.t === 'tts.done') {
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
        // Wire tts.done only means the daemon finished sending the TTS turn.
        // UI completion comes from the local TTSHandle after browser playback
        // has drained. If no handle is active, keep the old no-playback adapter
        // so snapshots/stale control streams can still close reducer state.
        if (!ttsRef.current) dispatch({ type: 'tts.done' });
        return;
      }
      if (msg.t === 'tts.error') {
        const reason = typeof msg.message === 'string' ? msg.message : 'tts_error';
        stopHoldMusicForControlMessage(msg, holdMusicRef.current);
        // Errors should surface immediately; the TTS handle will still observe
        // the control message and clean itself up, but clearing the ref prevents
        // its completion callback from dispatching a duplicate/stale event.
        ttsRef.current = null;
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
        runStartMic(rtcRef, sttRef, pendingSttStartRef, localSttStopInFlightRef, micBandsRef, dispatch);
      }
      else if (s.kind === 'stopMic') runStopMic(sttRef, pendingSttStartRef, localSttStopInFlightRef);
      else if (s.kind === 'cancelMic') runCancelMic(sttRef, pendingSttStartRef, localSttStopInFlightRef);
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
      pendingSttStartRef.current?.cancelLateHandle();
      localSttStopInFlightRef.current = false;
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

interface PendingSttStart {
  stopLateHandle(): void;
  cancelLateHandle(): void;
  shouldPreserveSnapshot(): boolean;
}

function hasActiveLocalSttLifecycle(
  sttRef: React.MutableRefObject<STTHandle | null>,
  pendingSttStartRef: React.MutableRefObject<PendingSttStart | null>,
  localSttStopInFlightRef: React.MutableRefObject<boolean>,
): boolean {
  return !!sttRef.current
    || !!pendingSttStartRef.current?.shouldPreserveSnapshot()
    || localSttStopInFlightRef.current;
}

function runStartMic(
  rtcRef: React.MutableRefObject<DrivingLoopOptions['rtc']>,
  sttRef: React.MutableRefObject<STTHandle | null>,
  pendingSttStartRef: React.MutableRefObject<PendingSttStart | null>,
  localSttStopInFlightRef: React.MutableRefObject<boolean>,
  micBandsRef: React.MutableRefObject<number[]>,
  dispatch: Dispatch,
): void {
  const pending: PendingSttStartState = { action: 'active' };
  let sttLifecycle: SttStartLifecycle = 'pending';
  let acceptedHandle: STTHandle | null = null;
  const pendingRef: PendingSttStart = {
    stopLateHandle: () => { pending.action = 'stop'; },
    cancelLateHandle: () => { pending.action = 'cancel'; sttLifecycle = 'cancelled'; },
    shouldPreserveSnapshot: () => pending.action !== 'cancel',
  };
  pendingSttStartRef.current = pendingRef;
  localSttStopInFlightRef.current = false;
  void (async () => {
    try {
      micBandsRef.current = [...QUIET_INTENSITIES];
      const handle = await startDaemonSTT({
        sendControl: rtcRef.current.sendControl,
        sendBinary: rtcRef.current.sendBinary,
        addControlListener: rtcRef.current.addControlListener,
        isConnected: () => rtcRef.current.status === 'open',
        onError: (reason) => {
          const acceptedPendingError = pendingSttStartRef.current === pendingRef;
          if (!shouldAcceptSttStartError(pendingSttStartRef, pendingRef, pending, sttLifecycle, acceptedHandle, sttRef, localSttStopInFlightRef)) return;
          if (acceptedPendingError) {
            pendingSttStartRef.current = null;
            pending.action = 'cancel';
            sttLifecycle = 'cancelled';
          }
          localSttStopInFlightRef.current = false;
          dispatch({ type: 'stt.error', reason });
        },
        onAudioFrame: (pcm) => {
          micBandsRef.current = mirrorCenterOutBands(
            pcm16ToBandIntensities(pcm, UNIQUE_WAVE_BANDS),
          );
        },
      });
      if (pendingSttStartRef.current !== pendingRef) {
        sttLifecycle = 'cancelled';
        handle.cancel();
        return;
      }
      pendingSttStartRef.current = null;
      if (pending.action === 'stop') {
        sttLifecycle = 'stopping';
        localSttStopInFlightRef.current = true;
        handle.stop().catch(() => undefined);
        return;
      }
      if (pending.action === 'cancel') {
        sttLifecycle = 'cancelled';
        localSttStopInFlightRef.current = false;
        handle.cancel();
        return;
      }
      const guardedHandle: STTHandle = {
        stop: () => {
          sttLifecycle = 'stopping';
          return handle.stop();
        },
        cancel: () => {
          sttLifecycle = 'cancelled';
          handle.cancel();
        },
      };
      acceptedHandle = guardedHandle;
      sttLifecycle = 'active';
      localSttStopInFlightRef.current = false;
      sttRef.current = guardedHandle;
    } catch (err) {
      if (pendingSttStartRef.current !== pendingRef) return;
      pendingSttStartRef.current = null;
      const reason =
        err instanceof DaemonNotConnectedError
          ? 'daemon_not_connected'
          : err instanceof MicPermissionError
            ? 'mic_denied'
            : err instanceof Error
              ? err.message
              : 'stt_start_failed';
      if (pending.action === 'cancel') {
        localSttStopInFlightRef.current = false;
        return;
      }
      localSttStopInFlightRef.current = false;
      dispatch({ type: 'stt.error', reason });
    }
  })();
}

type PendingSttStartState = { action: 'active' | 'stop' | 'cancel' };
type SttStartLifecycle = 'pending' | 'active' | 'stopping' | 'cancelled';

function shouldAcceptSttStartError(
  pendingSttStartRef: React.MutableRefObject<PendingSttStart | null>,
  pendingRef: PendingSttStart,
  pending: PendingSttStartState,
  lifecycle: SttStartLifecycle,
  acceptedHandle: STTHandle | null,
  sttRef: React.MutableRefObject<STTHandle | null>,
  localSttStopInFlightRef: React.MutableRefObject<boolean>,
): boolean {
  if (pendingSttStartRef.current === pendingRef) return pending.action !== 'cancel';
  if (lifecycle === 'active') return !!acceptedHandle && sttRef.current === acceptedHandle;
  if (lifecycle === 'stopping') return localSttStopInFlightRef.current;
  return false;
}

function runStopMic(
  sttRef: React.MutableRefObject<STTHandle | null>,
  pendingSttStartRef: React.MutableRefObject<PendingSttStart | null>,
  localSttStopInFlightRef: React.MutableRefObject<boolean>,
): void {
  const handle = sttRef.current;
  sttRef.current = null;
  const pendingStart = pendingSttStartRef.current;
  if (!handle) {
    if (pendingStart) {
      localSttStopInFlightRef.current = true;
      pendingStart.stopLateHandle();
    }
    return;
  }
  localSttStopInFlightRef.current = true;
  // stop() resolves with the final transcript. We don't need the value
  // here — the daemon will emit `stt.done` on the control channel, and
  // the listener above will turn that into an `stt.done` reducer event.
  handle.stop().catch(() => {
    // swallow — any real error will surface via stt.error on the wire
  });
}

function runCancelMic(
  sttRef: React.MutableRefObject<STTHandle | null>,
  pendingSttStartRef: React.MutableRefObject<PendingSttStart | null>,
  localSttStopInFlightRef: React.MutableRefObject<boolean>,
): void {
  const handle = sttRef.current;
  sttRef.current = null;
  localSttStopInFlightRef.current = false;
  if (!handle) {
    pendingSttStartRef.current?.cancelLateHandle();
    return;
  }
  pendingSttStartRef.current?.cancelLateHandle();
  handle.cancel();
}

function runArmTts(
  rtcRef: React.MutableRefObject<DrivingLoopOptions['rtc']>,
  ttsRef: React.MutableRefObject<TTSHandle | null>,
  dispatch: Dispatch,
  initialControlMessage?: ControlMessage,
): void {
  const activeTts = ttsRef.current;
  if (activeTts) {
    // Reconnect snapshots can hydrate `speaking` with reply text while the
    // original local playback handle is still draining. Keep that single
    // canonical playback lifecycle instead of overwriting it and leaking its
    // listeners. If the caller has an initial replay control, feed it into the
    // active lifecycle; otherwise arming is idempotent.
    if (initialControlMessage && typeof activeTts.handleControlMessage === 'function') {
      activeTts.handleControlMessage(initialControlMessage);
    }
    return;
  }

  const tts = playDaemonTts({
    addControlListener: rtcRef.current.addControlListener,
    addBinaryListener: rtcRef.current.addBinaryListener,
    sendControl: rtcRef.current.sendControl,
    ...(initialControlMessage ? { initialControlMessage } : {}),
  });
  ttsRef.current = tts;
  void tts.done.then(() => {
    if (ttsRef.current !== tts) return;
    ttsRef.current = null;
    if (tts.error) dispatch({ type: 'tts.error', reason: tts.error });
    else dispatch({ type: 'tts.done' });
  });
}

function runStopTts(ttsRef: React.MutableRefObject<TTSHandle | null>): void {
  const tts = ttsRef.current;
  ttsRef.current = null;
  tts?.stop({ cancelRemote: false });
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
  tts?.stop({ cancelRemote: false });
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

export interface SessionSnapshotReplayOptions {
  deferTtsDone?: boolean;
  deferTtsError?: boolean;
}

interface SnapshotHydrationPlan {
  hydration: DrivingHydration;
  transcript: CurrentTurnTranscript;
}

export function sessionSnapshotReplayPlanFromControlMessage(
  msg: ControlMessage,
  options: SessionSnapshotReplayOptions = {},
): SessionSnapshotReplayPlan | null {
  if (msg.t !== 'session.snapshot') return null;
  const controlEvents = sessionSnapshotControlEvents(msg);
  const events = controlEvents
    .filter((event) => !(options.deferTtsDone && event.t === 'tts.done'))
    .filter((event) => !(options.deferTtsError && event.t === 'tts.error'))
    .map(drivingReplayEventFromControlMessage)
    .filter((event): event is DrivingReplayEvent => !!event);
  const snapshot = sessionSnapshotRecord(msg);
  const hydrated = snapshot ? snapshotHydrationPlan(snapshot, options, events) : null;
  if (!hydrated && events.length === 0) return null;
  const terminalReplayWins = !!hydrated
    && hydrated.hydration.context.state !== 'idle'
    && events.some(isTerminalReplayEvent);
  return {
    event: {
      type: 'session.replay',
      events,
      ...(hydrated ? { hydration: hydrated.hydration } : {}),
    },
    transcript: terminalReplayWins
      ? { active: false, sttDone: false, text: '' }
      : hydrated?.transcript ?? null,
  };
}

function isSttTerminalControlMessage(msg: ControlMessage): boolean {
  return msg.t === 'stt.done' || msg.t === 'stt.error';
}

export function sessionSnapshotControlEvents(msg: ControlMessage): ControlMessage[] {
  const events = Array.isArray(msg.events) ? msg.events : [];
  return events
    .map((event): ControlMessage | null => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      const record = event as Record<string, unknown>;
      if (typeof record.t === 'string') return record as ControlMessage;
      const nested = record.msg;
      if (nested && typeof nested === 'object' && !Array.isArray(nested) && typeof (nested as { t?: unknown }).t === 'string') {
        return nested as ControlMessage;
      }
      return null;
    })
    .filter((event): event is ControlMessage => !!event);
}

function shouldPreserveActiveLocalSttSnapshot(
  msg: ControlMessage,
  plan: SessionSnapshotReplayPlan,
): boolean {
  if (msg.t !== 'session.snapshot') return false;
  if (plan.event.events.length > 0) return false;
  if (plan.event.hydration?.context.state !== 'idle') return false;
  const snapshot = sessionSnapshotRecord(msg);
  if (!snapshot) return false;
  return normalizeSnapshotPhase(
    firstString(snapshot, ['phase', 'turnPhase', 'status', 'state']),
    snapshot,
  ) === 'recording';
}

function shouldDiscardLocalSttForSnapshotReplay(plan: SessionSnapshotReplayPlan): boolean {
  return plan.event.events.length > 0 || !!plan.event.hydration;
}

function isTerminalReplayEvent(event: DrivingReplayEvent): boolean {
  return event.type === 'tts.done'
    || event.type === 'tts.error'
    || event.type === 'reply.error'
    || event.type === 'stt.error';
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
  if (msg.t === 'tts.start') {
    return {
      type: 'tts.start',
      ...(typeof msg.text === 'string' && msg.text.trim() ? { text: msg.text.trim() } : {}),
    };
  }
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

function snapshotHydrationPlan(
  source: Record<string, unknown>,
  options: SessionSnapshotReplayOptions = {},
  replayEvents: readonly DrivingReplayEvent[] = [],
): SnapshotHydrationPlan | null {
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
  if (!phase) return null;

  if (phase === 'completed') {
    const deferTtsTerminal = options.deferTtsDone || options.deferTtsError;
    return {
      hydration: {
        context: {
          ...initialContext,
          state: deferTtsTerminal ? 'ai' : 'idle',
          lastUserText,
          lastReplyText: replyText,
          liveReplyText: deferTtsTerminal ? replyText : '',
        },
        armTts: false,
      },
      transcript: { active: false, sttDone: false, text: '' },
    };
  }

  if (phase === 'reply-ready') {
    if (!hasReplayEvent(replayEvents, 'reply.done')) return null;
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
    if (!hasReplayEvent(replayEvents, 'tts.start')) return null;
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
          state: options.deferTtsError ? 'ai' : 'idle',
          lastUserText,
          lastReplyText: replyText,
          liveReplyText: options.deferTtsError ? replyText : '',
          error: options.deferTtsError ? null : error,
        },
        armTts: false,
      },
      transcript: { active: false, sttDone: false, text: '' },
    };
  }

  if (phase === 'thinking') {
    if (!hasReplayEvent(replayEvents, 'stt.done')) return null;
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
    // A reconnect/launch snapshot can report an in-progress mic/STT phase, but
    // hydration has no proof that this browser still owns a live local mic/STT
    // handle. Treat it as a safe idle state instead of rendering push-to-stop;
    // otherwise tapping stop would dispatch stopMic with no handle and leave the
    // reducer in thinking forever waiting for stt.done/stt.error.
    return {
      hydration: {
        context: {
          ...initialContext,
          state: 'idle',
          lastUserText: '',
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
        state: 'idle',
        lastUserText,
        lastReplyText: replyText,
      },
      armTts: false,
    },
    transcript: { active: false, sttDone: false, text: '' },
  };
}

function hasReplayEvent(
  events: readonly DrivingReplayEvent[],
  type: DrivingReplayEvent['type'],
): boolean {
  return events.some((event) => event.type === type);
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
  if (state === 'thinking' && analysers.length === 1 && getHoldMusicMuted()) return QUIET_INTENSITIES;

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
