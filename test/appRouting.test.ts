import { describe, expect, it } from 'vitest';
import { parseInitialLocation, parseInitialSearch } from '../client/src/app';
import { parseHandoffUrl } from '../client/src/voice/handoffUrl';

describe('client URL parsing (legacy query)', () => {
  it('defaults to the bad-session error instead of a handoff screen', () => {
    expect(parseInitialSearch('')).toMatchObject({
      screen: 'error',
      errorKind: 'bad_session',
    });
  });

  it('requires an explicit host peer id', () => {
    expect(parseInitialSearch('').hostPeerId).toBeNull();
    expect(parseInitialSearch('?screen=driving').hostPeerId).toBeNull();
  });

  it('preserves handoff host, session, and thread params', () => {
    expect(
      parseInitialSearch('?screen=driving&host=peer-1&session=session-1&threadId=thread-1'),
    ).toMatchObject({
      screen: 'driving',
      hostPeerId: 'peer-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
  });
});

describe('parseHandoffUrl', () => {
  it('parses handoff args from hash fragment', () => {
    expect(
      parseHandoffUrl('/voice#host=host-1&session=session-1&channel=discord&target=channel%3Athread-1'),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });
  });

  it('parses handoff args from query params for compatibility', () => {
    expect(
      parseHandoffUrl('/voice?host=host-1&session=session-1&channel=discord&target=channel%3Athread-1'),
    ).toMatchObject({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });
  });

  it('prefers hash args over query args', () => {
    expect(
      parseHandoffUrl(
        '/voice?host=query-host&session=query-session&channel=discord&target=channel%3Aquery#host=hash-host&session=hash-session&channel=slack&target=channel%3Ahash',
      ),
    ).toMatchObject({
      hostPeerId: 'hash-host',
      sessionId: 'hash-session',
      delivery: { channel: 'slack', target: 'channel:hash' },
    });
  });

  it('returns null when required args are missing', () => {
    expect(parseHandoffUrl('/voice')).toBeNull();
    expect(parseHandoffUrl('/voice#host=h&session=s')).toBeNull();
  });
});

describe('initial handoff routing', () => {
  it('opens valid voice handoff URLs directly in Driving', () => {
    expect(
      parseInitialLocation({
        search: '',
        hash: '#host=host-1&session=session-1&channel=discord&target=channel%3Athread-1',
      }),
    ).toMatchObject({
      screen: 'driving',
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      handoff: {
        delivery: { channel: 'discord', target: 'channel:thread-1' },
      },
    });
  });

  it('keeps invalid handoff URLs on the bad-session error', () => {
    expect(
      parseInitialLocation({
        search: '',
        hash: '#host=host-1&session=session-1',
      }),
    ).toMatchObject({
      screen: 'error',
      errorKind: 'bad_session',
      handoff: null,
    });
  });
});
