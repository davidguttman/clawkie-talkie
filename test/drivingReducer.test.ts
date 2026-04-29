// Pure-function tests for the Driving state machine — no React renderer
// needed. Each case names the event being delivered, the expected next
// state, and the side-effect intents the reducer should emit.

import { describe, it, expect } from 'vitest';
import {
  initialContext,
  reduce,
  type DrivingContext,
} from '../client/src/voice/drivingReducer';
import {
  composeTranscript,
  displayedCaptionText,
  isCurrentTurnTranscribing,
} from '../client/src/voice/drivingLoop';

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
  it('reply.done stays thinking, hides the reply text, and arms the TTS player', () => {
    const { next, side } = reduce(thinking, {
      type: 'reply.done',
      text: 'sup',
    });
    expect(next.state).toBe('thinking');
    expect(next.pendingReplyText).toBe('sup');
    expect(next.lastReplyText).toBe('');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([{ kind: 'armTts' }]);
  });

  it('tts.start with a pending reply reveals the response and enters ai', () => {
    const { next, side } = reduce(
      { ...thinking, pendingReplyText: 'sup', lastReplyText: 'previous audible reply' },
      { type: 'tts.start' },
    );

    expect(next.state).toBe('ai');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('sup');
    expect(next.liveReplyText).toBe('sup');
    expect(side).toEqual([]);
  });

  it('stale tts.start without a pending reply does not show previous turn text', () => {
    const { next, side } = reduce(
      {
        ...thinking,
        pendingReplyText: '',
        lastReplyText: 'previous audible reply',
        liveReplyText: '',
      },
      { type: 'tts.start' },
    );

    expect(next.state).toBe('thinking');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('previous audible reply');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([]);
  });

  it('reply.done then tts.error returns idle without exposing the pending reply', () => {
    let ctx = reduce(thinking, { type: 'reply.done', text: 'unheard reply' }).next;

    const { next, side } = reduce(ctx, {
      type: 'tts.error',
      reason: 'openclaw_infer_tts_failed',
    });

    expect(next.state).toBe('idle');
    expect(next.error).toBe('openclaw_infer_tts_failed');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([]);
  });

  it('reply.done then tts.done returns idle without exposing the pending reply', () => {
    const ctx = reduce(thinking, { type: 'reply.done', text: 'unheard reply' }).next;

    const { next, side } = reduce(ctx, { type: 'tts.done' });

    expect(next.state).toBe('idle');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([]);
  });

  it('reply.error returns to idle with the reason', () => {
    const { next, side } = reduce({ ...thinking, pendingReplyText: 'unheard reply' }, {
      type: 'reply.error',
      reason: 'xai_http_500',
    });
    expect(next.state).toBe('idle');
    expect(next.error).toBe('xai_http_500');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([]);
  });

  it('reply.done then tap cancel clears the pending unseen reply', () => {
    const ctx = reduce(thinking, { type: 'reply.done', text: 'unheard reply' }).next;

    const { next, side } = reduce(ctx, { type: 'tap' });

    expect(next.state).toBe('idle');
    expect(next.pendingReplyText).toBe('');
    expect(next.lastReplyText).toBe('');
    expect(next.liveReplyText).toBe('');
    expect(side).toEqual([{ kind: 'cancelReply' }]);
  });

  it('tap during thinking keeps waiting while current turn STT is still finalizing', () => {
    const { next, side } = reduce(thinking, { type: 'tap', currentTurnTranscribing: true });
    expect(next.state).toBe('thinking');
    expect(side).toEqual([]);
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
  it('idle → recording → thinking → reply ready hidden → ai → idle', () => {
    let ctx = idle;
    ctx = reduce(ctx, { type: 'tap' }).next;
    expect(ctx.state).toBe('recording');
    ctx = reduce(ctx, { type: 'tap' }).next;
    expect(ctx.state).toBe('thinking');
    ctx = reduce(ctx, { type: 'stt.done', text: 'hi' }).next;
    expect(ctx.state).toBe('thinking');
    ctx = reduce(ctx, { type: 'reply.done', text: 'hello' }).next;
    expect(ctx.state).toBe('thinking');
    expect(ctx.pendingReplyText).toBe('hello');
    expect(ctx.liveReplyText).toBe('');
    ctx = reduce(ctx, { type: 'tts.start' }).next;
    expect(ctx.state).toBe('ai');
    expect(ctx.pendingReplyText).toBe('');
    expect(ctx.liveReplyText).toBe('hello');
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

  it('does not reuse a previous turn transcript while a new turn is transcribing', () => {
    expect(
      displayedCaptionText(
        { ...initialContext, state: 'thinking', lastUserText: 'Oh my fucking god' },
        '',
      ),
    ).toBe('');
  });

  it('keeps the current final user transcript visible while waiting for the AI reply', () => {
    expect(
      displayedCaptionText(
        { ...initialContext, state: 'thinking', lastUserText: 'previous turn' },
        'current turn',
      ),
    ).toBe('current turn');
  });

  it('switches to the AI reply text only once the AI state starts', () => {
    expect(
      displayedCaptionText(
        { ...initialContext, state: 'ai', lastUserText: 'user words', liveReplyText: 'ai words' },
        'user words',
      ),
    ).toBe('ai words');
  });

  it('does not reveal a pending reply while still thinking', () => {
    expect(
      displayedCaptionText(
        {
          ...initialContext,
          state: 'thinking',
          lastUserText: 'user words',
          pendingReplyText: 'hidden ai words',
          liveReplyText: '',
        },
        'user words',
      ),
    ).toBe('user words');
  });
});

describe('isCurrentTurnTranscribing', () => {
  it('stays true while a current thinking turn is waiting for stt.done', () => {
    expect(
      isCurrentTurnTranscribing('thinking', {
        active: true,
        sttDone: false,
      }),
    ).toBe(true);
  });

  it('turns false after current stt.done', () => {
    expect(
      isCurrentTurnTranscribing('thinking', {
        active: true,
        sttDone: true,
      }),
    ).toBe(false);
  });

  it('does not infer transcribing from previous-turn text', () => {
    expect(
      isCurrentTurnTranscribing('thinking', {
        active: false,
        sttDone: false,
      }),
    ).toBe(false);
  });
});

describe('composeTranscript', () => {
  it('appends the current partial to committed final segments instead of replacing them', () => {
    expect(composeTranscript(['Okay, how we doing?', 'I really hope'], 'Oh my fucking god')).toBe(
      'Okay, how we doing? I really hope Oh my fucking god',
    );
  });
});
