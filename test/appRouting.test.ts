import { describe, expect, it } from 'vitest';
import { handoffToRendezvous, parseInitialLocation, parseInitialSearch, selectHandoffFromRecentSession } from '../client/src/app';
import { formatHandoffHash, parseHandoffUrl, parseHostDashboardUrl } from '../client/src/voice/handoffUrl';

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

  it('ignores legacy demo screen selection while preserving route params', () => {
    expect(
      parseInitialSearch('?screen=driving&host=peer-1&session=session-1&threadId=thread-1'),
    ).toMatchObject({
      screen: 'error',
      errorKind: 'bad_session',
      hostPeerId: 'peer-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
  });

  it('recognizes the replaced-phone error state', () => {
    expect(parseInitialSearch('?screen=error&errorKind=replaced')).toMatchObject({
      screen: 'error',
      errorKind: 'replaced',
    });
  });
});

describe('parseHandoffUrl', () => {
  it('parses host+session handoff args from hash fragment', () => {
    expect(
      parseHandoffUrl('/voice#host=host-1&session=session-1'),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
    });
  });

  it('parses optional sessionKey, channel, target, and accountId routing metadata from handoff args', () => {
    expect(
      parseHandoffUrl('/voice#host=host-1&session=session-uuid&sessionKey=agent%3Amain%3Adiscord%3Achannel%3Athread-1&channel=discord&target=channel%3Athread-1&accountId=acct-1'),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'session-uuid',
      sessionKey: 'agent:main:discord:channel:thread-1',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
    });
  });

  it('preserves explicit channel and target handoff args when present', () => {
    expect(
      parseHandoffUrl('/voice#host=host-1&session=session-1&channel=discord&target=channel%3Athread-1'),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      channel: 'discord',
      target: 'channel:thread-1',
    });
  });

  it('parses handoff args from query params for compatibility', () => {
    expect(
      parseHandoffUrl('/voice?host=host-1&session=session-1'),
    ).toMatchObject({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
    });
  });

  it('prefers hash args over query args', () => {
    expect(
      parseHandoffUrl(
        '/voice?host=query-host&session=query-session#host=hash-host&session=hash-session',
      ),
    ).toMatchObject({
      hostPeerId: 'hash-host',
      sessionId: 'hash-session',
    });
  });

  it('returns null when required handoff args are missing', () => {
    expect(parseHandoffUrl('/voice')).toBeNull();
    expect(parseHandoffUrl('/voice#host=h&channel=webchat')).toBeNull();
    expect(parseHandoffUrl('/voice#session=s&channel=webchat')).toBeNull();
  });

  it('parses host-only dashboard URLs without treating them as handoffs', () => {
    expect(parseHostDashboardUrl('/dashboard#host=host-1')).toEqual({ hostPeerId: 'host-1' });
    expect(parseHostDashboardUrl('/voice#host=host-1')).toEqual({ hostPeerId: 'host-1' });
    expect(parseHostDashboardUrl('/?host=host-1')).toBeNull();
    expect(parseHostDashboardUrl('/voice#host=host-1&session=session-1')).toBeNull();
  });

  it('formats selected session handoff hashes with hash-scoped identifiers', () => {
    expect(formatHandoffHash({
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      sessionKey: 'agent:main:main',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
    })).toBe('#host=host-1&session=session-1&sessionKey=agent%3Amain%3Amain&channel=discord&target=channel%3Athread-1&accountId=acct-1');
  });
});

describe('initial handoff routing', () => {
  it('opens valid voice handoff URLs directly in Driving', () => {
    expect(
      parseInitialLocation({
        search: '',
        hash: '#host=host-1&session=session-1&sessionKey=agent%3Amain%3Adiscord%3Achannel%3Athread-1&channel=discord&target=channel%3Athread-1&accountId=acct-1',
      }),
    ).toMatchObject({
      screen: 'driving',
      hostPeerId: 'host-1',
      sessionId: 'session-1',
      handoff: {
        sessionId: 'session-1',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      },
    });
  });

  it('routes host-only dashboard URLs to the dashboard instead of bad-session', () => {
    expect(
      parseInitialLocation({
        pathname: '/dashboard',
        search: '',
        hash: '#host=host-1',
      }),
    ).toMatchObject({
      screen: 'dashboard',
      hostPeerId: 'host-1',
      sessionId: undefined,
      handoff: null,
    });

    expect(
      parseInitialLocation({
        pathname: '/voice',
        search: '',
        hash: '#host=host-1',
      }),
    ).toMatchObject({
      screen: 'dashboard',
      hostPeerId: 'host-1',
      handoff: null,
    });
  });

  it('recovers a saved host for PWA dashboard launches with no URL host', () => {
    expect(
      parseInitialLocation(
        {
          pathname: '/dashboard/',
          search: '',
          hash: '',
        },
        { savedDashboardHostPeerId: ' saved-host ' },
      ),
    ).toMatchObject({
      screen: 'dashboard',
      hostPeerId: 'saved-host',
      sessionId: undefined,
      handoff: null,
    });
  });

  it('does not route root query host URLs because root is marketing-only', () => {
    expect(
      parseInitialLocation({
        pathname: '/',
        search: '?host=host-1',
        hash: '',
      }),
    ).toMatchObject({
      screen: 'error',
      errorKind: 'bad_session',
      hostPeerId: 'host-1',
      handoff: null,
    });
  });

  it('keeps URLs without a host on the bad-session error', () => {
    expect(
      parseInitialLocation({
        search: '',
        hash: '',
      }),
    ).toMatchObject({
      screen: 'error',
      errorKind: 'bad_session',
      handoff: null,
    });
  });
});


describe('session picker handoff selection', () => {
  it('keeps OpenClaw discovery details in daemon-provided session metadata', () => {
    expect(
      selectHandoffFromRecentSession(
        {
          hostPeerId: 'host-1',
          sessionId: 'old-session',
          sessionKey: 'agent:main:discord:channel:old',
          channel: 'discord',
          target: 'channel:old',
        },
        {
          sessionId: 'new-session-uuid',
          sessionKey: 'agent:kamaji:discord:channel:new-thread',
          agent: 'kamaji',
          channel: 'discord',
          target: 'channel:new-thread',
          accountId: 'acct-1',
          displayLabel: 'New thread',
        },
      ),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'new-session-uuid',
      sessionKey: 'agent:kamaji:discord:channel:new-thread',
      channel: 'discord',
      target: 'channel:new-thread',
      accountId: 'acct-1',
    });
  });

  it('builds a handoff from dashboard host context when no session is active yet', () => {
    expect(
      selectHandoffFromRecentSession(
        null,
        {
          sessionId: 'session-uuid',
          sessionKey: 'agent:kamaji:main',
          agent: 'kamaji',
          displayLabel: 'Main',
        },
        'host-1',
      ),
    ).toEqual({
      hostPeerId: 'host-1',
      sessionId: 'session-uuid',
      sessionKey: 'agent:kamaji:main',
    });
  });

  it('maps a selected handoff to rendezvous props without a full reload', () => {
    expect(
      handoffToRendezvous({
        hostPeerId: 'host-1',
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:t1',
        channel: 'discord',
        target: 'channel:t1',
        accountId: 'acct-1',
      }),
    ).toEqual({
      sessionId: 'session-uuid',
      sessionKey: 'agent:main:discord:channel:t1',
      channel: 'discord',
      target: 'channel:t1',
      accountId: 'acct-1',
    });
  });
});
