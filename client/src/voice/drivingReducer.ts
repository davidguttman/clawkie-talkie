// Pure state reducer for the Driving screen. Exposed independently of
// the React hook so it can be tested without a render environment.
//
// States:
//   idle       → waiting for the user to tap start
//   recording  → mic is open; daemon is running xAI STT
//   thinking   → mic closed; daemon running xAI chat on the transcript
//   ai         → daemon running xAI TTS; phone is playing audio
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
  // Render label source for the AI caption.
  liveReplyText: string;
  error: string | null;
}

export type DrivingEvent =
  | { type: 'tap' }
  | { type: 'silence' }
  | { type: 'stt.done'; text: string }
  | { type: 'stt.error'; reason: string }
  | { type: 'reply.done'; text: string }
  | { type: 'reply.error'; reason: string }
  | { type: 'tts.start' }
  | { type: 'tts.done' }
  | { type: 'tts.error'; reason: string };

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
  liveReplyText: '',
  error: null,
};

export function reduce(ctx: DrivingContext, event: DrivingEvent): Reduction {
  switch (ctx.state) {
    case 'idle':
      if (event.type === 'tap') {
        return {
          next: { ...ctx, state: 'recording', error: null, liveReplyText: '' },
          side: [{ kind: 'startMic' }],
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
          next: { ...ctx, state: 'ai', lastReplyText: event.text, liveReplyText: event.text },
          side: [{ kind: 'armTts' }],
        };
      }
      if (event.type === 'reply.error' || event.type === 'stt.error') {
        return {
          next: { ...ctx, state: 'idle', error: event.reason },
          side: [],
        };
      }
      if (event.type === 'tap') {
        // Double-tap from thinking bails out of the turn.
        return {
          next: { ...ctx, state: 'idle' },
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
          next: { ...ctx, state: 'idle', error: event.reason },
          side: [],
        };
      }
      return { next: ctx, side: [] };
  }
}
