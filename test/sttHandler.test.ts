// Pure-function tests for the xAI STT event handler. The xAI streaming
// API has been observed shipping `transcript.partial { is_final: true }`
// with empty text, and `transcript.done` with empty text or only the last
// segment even when real words were committed in earlier finals. Both
// cases used to wipe prior text on the phone. The handler now drops empty
// partials and preserves the accumulated finals on done.

import { describe, it, expect, vi } from 'vitest';
import {
  createSttHandlerState,
  handleSttEvent,
  mergeFinal,
  selectFinalTranscript,
  type SttHandlerCallbacks,
  type SttHandlerState,
  type SttServerEvent,
} from '../daemon/src/sttSession';

function makeCb() {
  return {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  } satisfies SttHandlerCallbacks;
}

describe('handleSttEvent', () => {
  it('fires onReady once on transcript.created', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.created' }, cb);
    handleSttEvent(s, { type: 'transcript.created' }, cb);
    expect(cb.onReady).toHaveBeenCalledTimes(1);
  });

  it('drops empty partials (final or not) so they do not wipe UI', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    const events: SttServerEvent[] = [
      { type: 'transcript.partial', text: '', is_final: false },
      { type: 'transcript.partial', text: '   ', is_final: true },
    ];
    for (const e of events) handleSttEvent(s, e, cb);
    expect(cb.onPartial).not.toHaveBeenCalled();
  });

  it('forwards non-empty partials and accumulates finals', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello', is_final: false }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello there', is_final: true }, cb);
    expect(cb.onPartial).toHaveBeenCalledWith('hello', false);
    expect(cb.onPartial).toHaveBeenCalledWith('hello there', true);
    expect(s.finals).toEqual(['hello there']);
  });

  it('falls back to accumulated finals when transcript.done is empty', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello there', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'friend', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: '' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('hello there friend');
  });

  it('keeps accumulated finals when transcript.done only contains the last segment', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'Okay, how we doing?', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'I really hope', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'Oh my fucking god', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: 'Oh my fucking god' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith(
      'Okay, how we doing? I really hope Oh my fucking god',
    );
  });

  it('prefers transcript.done text when it is longer than accumulated finals', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hi', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: 'hello there friend' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('hello there friend');
  });

  it('emits empty done when both done text and finals are empty', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.done', text: '' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('');
  });

  it('only fires onDone once', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.done', text: 'hi' }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: 'hi' }, cb);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
  });

  it('passes error messages through', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'error', message: 'boom' }, cb);
    expect(cb.onError).toHaveBeenCalledWith('boom');
  });

  it('dedupes cumulative finals so `hello` then `hello world` finals to `hello world`', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello world', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: '' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('hello world');
  });

  it('still handles segmented finals when done is empty (`hello` + `world` → `hello world`)', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.partial', text: 'world', is_final: true }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: '' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('hello world');
  });

  it('falls back to the latest partial when both done and finals are empty', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello world', is_final: false }, cb);
    handleSttEvent(s, { type: 'transcript.done', text: '' }, cb);
    expect(cb.onDone).toHaveBeenCalledWith('hello world');
  });

  it('prefers done when it is a strict superset of bestFinals', () => {
    const cb = makeCb();
    const s = createSttHandlerState();
    handleSttEvent(s, { type: 'transcript.partial', text: 'hello world', is_final: true }, cb);
    handleSttEvent(
      s,
      { type: 'transcript.done', text: 'hello world how are you' },
      cb,
    );
    expect(cb.onDone).toHaveBeenCalledWith('hello world how are you');
  });
});

describe('mergeFinal', () => {
  it('returns next when prev is empty', () => {
    expect(mergeFinal('', 'hi')).toBe('hi');
  });
  it('returns prev when next is empty', () => {
    expect(mergeFinal('hi', '')).toBe('hi');
  });
  it('replaces prev with next when next extends prev (cumulative finals)', () => {
    expect(mergeFinal('hello', 'hello world')).toBe('hello world');
  });
  it('keeps prev when prev already contains next (server retraction / repeat)', () => {
    expect(mergeFinal('hello world', 'hello')).toBe('hello world');
    expect(mergeFinal('hello world friend', 'world')).toBe('hello world friend');
  });
  it('concatenates independent segments with a single space', () => {
    expect(mergeFinal('hello', 'world')).toBe('hello world');
  });
});

describe('selectFinalTranscript', () => {
  function stateFrom(opts: {
    bestFinals?: string;
    latestPartial?: string;
  }): SttHandlerState {
    return {
      readyFired: true,
      doneFired: false,
      finals: [],
      bestFinals: opts.bestFinals ?? '',
      latestPartial: opts.latestPartial ?? '',
    };
  }

  it('uses done text when finals are empty', () => {
    expect(selectFinalTranscript(stateFrom({}), 'hello')).toBe('hello');
  });
  it('uses finals when done is empty', () => {
    expect(selectFinalTranscript(stateFrom({ bestFinals: 'hello world' }), '')).toBe(
      'hello world',
    );
  });
  it('falls back to latest partial when both done and finals are empty', () => {
    expect(
      selectFinalTranscript(stateFrom({ latestPartial: 'maybe this' }), ''),
    ).toBe('maybe this');
  });
  it('prefers finals when done is just the trailing segment', () => {
    expect(
      selectFinalTranscript(
        stateFrom({ bestFinals: 'hello there friend' }),
        'friend',
      ),
    ).toBe('hello there friend');
  });
  it('prefers done when it strictly extends finals', () => {
    expect(
      selectFinalTranscript(stateFrom({ bestFinals: 'hello' }), 'hello there'),
    ).toBe('hello there');
  });
  it('uses the longer of two independent strings as a tie-breaker', () => {
    expect(
      selectFinalTranscript(stateFrom({ bestFinals: 'hi' }), 'hello there friend'),
    ).toBe('hello there friend');
  });
});
