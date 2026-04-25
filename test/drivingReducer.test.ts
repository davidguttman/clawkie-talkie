// Pure-function tests for the Driving state machine — no React renderer
// needed. Each case names the event being delivered, the expected next
// state, and the side-effect intents the reducer should emit.

import { describe, it, expect } from 'vitest';
import {
  initialContext,
  reduce,
  type DrivingContext,
} from '../client/src/voice/drivingReducer';
import { composeTranscript, displayedCaptionText } from '../client/src/voice/drivingLoop';

const idle: DrivingContext = { ...initialContext };
const recording: DrivingContext = { ...initialContext, state: 'recording' };
const thinking: DrivingContext = {
  ...initialContext,
  state: 'thinking',
  lastUserText: 'hello',
};
const ai: DrivingContext = {
  ...initialContext,
  state: 'ai',
  lastUserText: 'hello',
  lastReplyText: 'hi there',
  liveReplyText: 'hi there',
};

describe('idle', () => {
  it('tap moves to recording and arms the mic', () => {
    const { next, side } = reduce(idle, { type: 'tap' });
    expect(next.state).toBe('recording');
    expect(next.error).toBeNull();
    expect(side).toEqual([{ kind: 'startMic' }]);
  });

  it('ignores unrelated events', () => {
    expect(reduce(idle, { type: 'silence' }).next.state).toBe('idle');
    expect(reduce(idle, { type: 'stt.done', text: 'x' }).next.state).toBe('idle');
    expect(reduce(idle, { type: 'tts.done' }).next.state).toBe('idle');
  });
});

describe('recording', () => {
  it('tap stops the mic and enters thinking', () => {
    const { next, side } = reduce(recording, { type: 'tap' });
    expect(next.state).toBe('thinking');
    expect(side).toEqual([{ kind: 'stopMic' }]);
  });

  it('stt.error cancels back to idle with the reason surfaced', () => {
    const { next, side } = reduce(recording, {
      type: 'stt.error',
      reason: 'mic_denied',
    });
    expect(next.state).toBe('idle');
    expect(next.error).toBe('mic_denied');
    expect(side).toEqual([{ kind: 'cancelMic' }]);
  });
});

describe('thinking', () => {
  it('reply.done moves to ai and arms the TTS player', () => {
    const { next, side } = reduce(thinking, {
      type: 'reply.done',
      text: 'sup',
    });
    expect(next.state).toBe('ai');
    expect(next.lastReplyText).toBe('sup');
    expect(next.liveReplyText).toBe('sup');
    expect(side).toEqual([{ kind: 'armTts' }]);
  });

  it('reply.error returns to idle with the reason', () => {
    const { next, side } = reduce(thinking, {
      type: 'reply.error',
      reason: 'xai_http_500',
    });
    expect(next.state).toBe('idle');
    expect(next.error).toBe('xai_http_500');
    expect(side).toEqual([]);
  });

  it('tap during thinking cancels the reply and returns to idle', () => {
    const { next, side } = reduce(thinking, { type: 'tap' });
    expect(next.state).toBe('idle');
    expect(side).toEqual([{ kind: 'cancelReply' }]);
  });

  it('stt.done just records the user text without state change', () => {
    const { next, side } = reduce(thinking, { type: 'stt.done', text: 'HELLO' });
    expect(next.state).toBe('thinking');
    expect(next.lastUserText).toBe('HELLO');
    expect(side).toEqual([]);
  });
});

describe('ai', () => {
  it('tts.done returns to idle with no further side-effects', () => {
    const { next, side } = reduce(ai, { type: 'tts.done' });
    expect(next.state).toBe('idle');
    expect(side).toEqual([]);
  });

  it('silence stops TTS and returns to idle', () => {
    const { next, side } = reduce(ai, { type: 'silence' });
    expect(next.state).toBe('idle');
    expect(side).toEqual([{ kind: 'stopTts' }]);
  });

  it('tap stops TTS and returns to idle', () => {
    const { next, side } = reduce(ai, { type: 'tap' });
    expect(next.state).toBe('idle');
    expect(side).toEqual([{ kind: 'stopTts' }]);
  });

  it('tts.error surfaces the reason and returns to idle', () => {
    const { next, side } = reduce(ai, { type: 'tts.error', reason: 'x' });
    expect(next.state).toBe('idle');
    expect(next.error).toBe('x');
    expect(side).toEqual([]);
  });
});

describe('full happy-path sequence', () => {
  it('idle → recording → thinking → ai → idle', () => {
    let ctx = idle;
    ctx = reduce(ctx, { type: 'tap' }).next;
    expect(ctx.state).toBe('recording');
    ctx = reduce(ctx, { type: 'tap' }).next;
    expect(ctx.state).toBe('thinking');
    ctx = reduce(ctx, { type: 'stt.done', text: 'hi' }).next;
    expect(ctx.state).toBe('thinking');
    ctx = reduce(ctx, { type: 'reply.done', text: 'hello' }).next;
    expect(ctx.state).toBe('ai');
    ctx = reduce(ctx, { type: 'tts.done' }).next;
    expect(ctx.state).toBe('idle');
    expect(ctx.lastReplyText).toBe('hello');
    expect(ctx.lastUserText).toBe('hi');
  });
});

describe('displayedCaptionText', () => {
  it('keeps the live transcript visible while thinking before final STT arrives', () => {
    expect(displayedCaptionText({ ...initialContext, state: 'thinking' }, 'Okay, how we doing?')).toBe(
      'Okay, how we doing?',
    );
  });

  it('keeps the final user transcript visible while waiting for the AI reply', () => {
    expect(
      displayedCaptionText(
        { ...initialContext, state: 'thinking', lastUserText: 'Oh my fucking god' },
        '',
      ),
    ).toBe('Oh my fucking god');
  });

  it('switches to the AI reply text only once the AI state starts', () => {
    expect(
      displayedCaptionText(
        { ...initialContext, state: 'ai', lastUserText: 'user words', liveReplyText: 'ai words' },
        'user words',
      ),
    ).toBe('ai words');
  });
});

describe('composeTranscript', () => {
  it('appends the current partial to committed final segments instead of replacing them', () => {
    expect(composeTranscript(['Okay, how we doing?', 'I really hope'], 'Oh my fucking god')).toBe(
      'Okay, how we doing? I really hope Oh my fucking god',
    );
  });
});
