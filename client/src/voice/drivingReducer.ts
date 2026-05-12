// Pure state reducer for the Driving screen. Exposed independently of
// the React hook so it can be tested without a render environment.
//
// States:
//   idle       → waiting for the user to tap start
//   recording  → mic is open; daemon is recording audio for OpenClaw infer STT
//   thinking   → mic closed; daemon running xAI chat on the transcript
//   ai         → daemon running OpenClaw infer TTS; phone is playing audio
//
// Events come from the UI (tap / silence) and from daemon control
// messages (stt.done / stt.error / reply.done / reply.error / tts.done
// / tts.error). The reducer returns the next state plus a list of
// side-effect intents that the hook performs outside the reducer.

export type DrivingState = 'idle' | 'recording' | 'thinking' | 'ai';


export interface DrivingContext {
  state: DrivingState;
  lastUserText: string;
  lastReplyText: string;
  // Reply text received before audio starts. Kept hidden until tts.start.
  pendingReplyText: string;
  // Render label source for the AI caption.
  liveReplyText: string;
  error: string | null;
}

export type DrivingReplayEvent =
  | { type: 'tap'; currentTurnTranscribing?: boolean }
  | { type: 'silence' }
  | { type: 'stt.done'; text: string }
  | { type: 'stt.error'; reason: string }
  | { type: 'reply.done'; text: string }
  | { type: 'reply.error'; reason: string }
  | { type: 'tts.start'; text?: string }
  | { type: 'tts.done' }
  | { type: 'tts.error'; reason: string };

export interface DrivingHydration {
  context: DrivingContext;
  armTts?: boolean;
}

export type DrivingEvent =
  | DrivingReplayEvent
  | { type: 'session.replay'; events: DrivingReplayEvent[]; hydration?: DrivingHydration }
  | { type: 'session.reset' };

export type DrivingSideEffect =
  | { kind: 'startMic' }
  | { kind: 'stopMic' }
  | { kind: 'cancelMic' }
  | { kind: 'armTts' }
  | { kind: 'stopTts' }
  | { kind: 'cancelReply' };

export interface Reduction {
  next: DrivingContext;
  side: DrivingSideEffect[];
}

export const initialContext: DrivingContext = {
  state: 'idle',
  lastUserText: '',
  lastReplyText: '',
  pendingReplyText: '',
  liveReplyText: '',
  error: null,
};


export function reduce(ctx: DrivingContext, event: DrivingEvent): Reduction {
  if (event.type === 'session.replay') return reduceSessionReplay(ctx, event);
  if (event.type === 'session.reset') return { next: { ...initialContext }, side: [] };

  switch (ctx.state) {
    case 'idle':
      if (event.type === 'tap') {
        return {
          next: { ...ctx, state: 'recording', error: null, pendingReplyText: '', liveReplyText: '' },
          side: [{ kind: 'startMic' }],
        };
      }
      if (event.type === 'tts.start') {
        return {
          next: {
            ...ctx,
            state: 'ai',
            ...(event.text ? { lastReplyText: event.text, liveReplyText: event.text } : {}),
            error: null,
          },
          side: [],
        };
      }
      return { next: ctx, side: [] };

    case 'recording':
      if (event.type === 'tap') {
        return {
          next: { ...ctx, state: 'thinking' },
          side: [{ kind: 'stopMic' }],
        };
      }
      if (event.type === 'stt.error') {
        return {
          next: { ...ctx, state: 'idle', error: event.reason },
          side: [{ kind: 'cancelMic' }],
        };
      }
      return { next: ctx, side: [] };

    case 'thinking':
      if (event.type === 'stt.done') {
        // Final transcript arrives while already in `thinking`. Don't
        // start anything new — daemon pipelines chat automatically.
        return { next: { ...ctx, lastUserText: event.text }, side: [] };
      }
      if (event.type === 'reply.done') {
        return {
          next: { ...ctx, pendingReplyText: event.text, liveReplyText: '' },
          side: [{ kind: 'armTts' }],
        };
      }
      if (event.type === 'tts.start') {
        const replyText = ctx.pendingReplyText || event.text || '';
        if (!replyText) return { next: ctx, side: [] };
        return {
          next: {
            ...ctx,
            state: 'ai',
            lastReplyText: replyText,
            liveReplyText: replyText,
            pendingReplyText: '',
          },
          side: [],
        };
      }
      if (event.type === 'reply.error' || event.type === 'stt.error') {
        return {
          next: { ...ctx, state: 'idle', error: event.reason, pendingReplyText: '', liveReplyText: '' },
          side: [],
        };
      }
      if (event.type === 'tts.done') {
        return {
          next: { ...ctx, state: 'idle', pendingReplyText: '', liveReplyText: '' },
          side: [],
        };
      }
      if (event.type === 'tts.error') {
        // Audio synthesis is non-fatal once the reply itself was generated:
        // promote the pending reply into the visible "last AI turn" so the
        // user can still read what was said and surface a soft audio error.
        return {
          next: {
            ...ctx,
            state: 'idle',
            error: event.reason,
            lastReplyText: ctx.pendingReplyText || ctx.lastReplyText,
            pendingReplyText: '',
            liveReplyText: '',
          },
          side: [],
        };
      }
      if (event.type === 'tap') {
        if (event.currentTurnTranscribing) {
          return { next: ctx, side: [] };
        }
        // Double-tap from thinking bails out of the turn after the
        // authoritative STT final has arrived and the reply turn is running.
        return {
          next: { ...ctx, state: 'idle', pendingReplyText: '', liveReplyText: '' },
          side: [{ kind: 'cancelReply' }],
        };
      }
      return { next: ctx, side: [] };

    case 'ai':
      if (event.type === 'tap' || event.type === 'silence') {
        return {
          next: { ...ctx, state: 'idle' },
          side: [{ kind: 'stopTts' }],
        };
      }
      if (event.type === 'tts.done') {
        return { next: { ...ctx, state: 'idle' }, side: [] };
      }
      if (event.type === 'tts.error') {
        return {
          next: { ...ctx, state: 'idle', error: event.reason, liveReplyText: '' },
          side: [],
        };
      }
      return { next: ctx, side: [] };
  }
}

function reduceSessionReplay(
  ctx: DrivingContext,
  event: Extract<DrivingEvent, { type: 'session.replay' }>,
): Reduction {
  let next = ctx;
  let side: DrivingSideEffect[] = [];
  const hasTerminalReplayEvent = event.events.some(isTerminalReplayEvent);
  for (const replayEvent of event.events) {
    const reduced = reduce(next, replayEvent);
    next = reduced.next;
    side.push(...reduced.side);
  }
  if (event.hydration) {
    const terminalReplayWins =
      hasTerminalReplayEvent && next.state === 'idle' && event.hydration.context.state !== 'idle';
    if (terminalReplayWins) {
      next = { ...next, pendingReplyText: '', liveReplyText: '' };
    } else {
      next = event.hydration.context;
      if (event.hydration.armTts && !side.some((item) => item.kind === 'armTts')) {
        side.push({ kind: 'armTts' });
      }
    }
    if ((!event.hydration.armTts || terminalReplayWins) && next.state === 'idle' && !next.pendingReplyText) {
      side = side.filter((item) => item.kind !== 'armTts');
    }
  }
  return { next, side };
}

function isTerminalReplayEvent(event: DrivingReplayEvent): boolean {
  return event.type === 'tts.done'
    || event.type === 'tts.error'
    || event.type === 'reply.error'
    || event.type === 'stt.error';
}
