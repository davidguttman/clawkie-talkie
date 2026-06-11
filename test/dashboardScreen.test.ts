// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const rtcMock = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock('../client/src/rtc/RtcContext', () => ({
  useRtc: () => rtcMock.current,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import {
  DashboardScreen,
  filterNewSessionDestinations,
  formatNewSessionCreateError,
  formatRelativeActivity,
  groupNewSessionDestinations,
  listSelectableNewSessionProviders,
} from '../client/src/screens/Dashboard';

const source = readFileSync(resolve(process.cwd(), 'client/src/screens/Dashboard.tsx'), 'utf8');

describe('Dashboard session discovery state guards', () => {
  it('does not render timeout or unsupported notices after any recent-session response exists', () => {
    expect(source).toMatch(/const hasRecentSessionResponse\s*=\s*rtc\.recentSessions\.length > 0 \|\| !!rtc\.recentSessionsGeneratedAt;/);
    expect(source).toMatch(/const showUnsupported\s*=\s*supportStatus === 'unsupported' && !hasRecentSessionResponse;/);
    expect(source).toContain('const showTimedOut = refresh.timedOut && !hasRecentSessionResponse;');
    expect(source).toMatch(/\{showTimedOut && \(?\s*<Notice tone="warn">[\s\S]*?No recent-session response yet\. The daemon may still be starting\.[\s\S]*?<\/Notice>/);
    expect(source).toMatch(/\{showUnsupported && \(?\s*<Notice tone="warn">[\s\S]*?This daemon does not support host dashboard session discovery\.[\s\S]*?<\/Notice>/);
  });

  it('keeps the empty unsupported state behind the same guarded flag', () => {
    expect(source).toContain('unsupported={showUnsupported}');
    expect(source).toContain("? 'Session discovery is unavailable for this daemon.'");
  });

  it('uses Recent Sessions as the dashboard heading without the eyebrow label', () => {
    expect(source).toContain('Recent Sessions');
    expect(source).not.toContain('Pick a session');
    expect(source).not.toContain('CLAWKIE-TALKIE DASHBOARD');
    expect(source).not.toContain('CLAWKIE DASHBOARD');
  });

  it('uses a slower startup timeout for the host dashboard refresh notice', () => {
    expect(source).toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 12_000;');
    expect(source).not.toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 3500;');
  });

  it('exposes a History entry point in the dashboard header', () => {
    expect(source).toContain('onHistory,');
    expect(source).toContain('onHistory?: () => void;');
    expect(source).toContain('aria-label="History"');
    expect(source).toContain('onClick={onHistory}');
    expect(source).toContain('HISTORY');
  });

  it('exposes a reconnect control when the dashboard RTC connection can be retried', () => {
    expect(source).toContain('rtc.canRetryConnection');
    expect(source).toContain('rtc.retryConnection');
    expect(source).toMatch(/\{rtc\.canRetryConnection\s*\?\s*'RECONNECT'\s*:\s*waiting\s*\?\s*'REFRESHING…'\s*:\s*'REFRESH'\}/);
    expect(source).toMatch(/disabled=\{\s*!rtc\.canRetryConnection && \(waiting \|\| rtc\.status !== 'open'\)\s*\}/);
  });

  it('keeps the host id off the dashboard while still showing daemon status', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rtcMock.current = {
      status: 'open',
      detail: '',
      canRetryConnection: false,
      retryConnection: vi.fn(),
      recentSessionsGeneratedAt: new Date().toISOString(),
      recentSessionsSupportStatus: 'supported',
      recentSessionsResponseSeq: 1,
      requestRecentSessions: vi.fn(),
      recentSessions: [],
      newSessionsSupported: false,
      newSessionDestinationsCatalog: null,
      newSessionDestinationsResponseSeq: 0,
      requestNewSessionDestinations: vi.fn(),
    };

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'secret-host-id', onSelectSession: vi.fn() }));
    });

    expect(container.textContent).toContain('CONNECTED');
    expect(container.textContent).toContain('daemon connection');
    expect(container.textContent).toContain('updated just now');
    expect(container.textContent).not.toContain('secret-host-id');
    expect(container.querySelector('[title="secret-host-id"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});


describe('Dashboard recent session row labels', () => {
  it('orders the session info bar as agent, channel, relative time', () => {
    const agentIndex = source.indexOf("<span>{session.agent || 'unknown'}</span>");
    const channelIndex = source.indexOf("{session.channel && <span>{session.channel}</span>}");
    const timeIndex = source.search(/\{session\.lastActivity && \(?[\s\S]*?formatRelativeActivity\(session\.lastActivity\)[\s\S]*?\}?/);

    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(channelIndex).toBeGreaterThan(agentIndex);
    expect(timeIndex).toBeGreaterThan(channelIndex);
    expect(source).not.toContain('formatActivity(session.lastActivity)');
  });

  it('renders a compact assistant preview line ahead of the latest user preview', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rtcMock.current = {
      status: 'open',
      detail: '',
      canRetryConnection: false,
      retryConnection: vi.fn(),
      recentSessionsGeneratedAt: '2026-05-05T19:30:00.000Z',
      recentSessionsSupportStatus: 'supported',
      recentSessionsResponseSeq: 1,
      requestRecentSessions: vi.fn(),
      newSessionsSupported: false,
      newSessionDestinationsCatalog: null,
      newSessionDestinationsResponseSeq: 0,
      requestNewSessionDestinations: vi.fn(),
      recentSessions: [
        {
          sessionId: 'session-1',
          sessionKey: 'agent:alpha:main',
          agent: 'alpha',
          channel: 'discord',
          displayLabel: 'Hydrated session',
          lastActivity: '2026-05-05T19:29:00.000Z',
          lastMessageRole: 'user',
          lastMessagePreview: 'User asked for a dashboard preview.',
          lastAssistantPreview: 'Assistant hydrated reply.',
        },
      ],
    };

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession: vi.fn() }));
    });

    expect(container.textContent).toContain('Agent: Assistant hydrated reply.');
    expect(container.textContent).not.toContain('Latest user: User asked for a dashboard preview.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the latest message preview when no assistant preview is available', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rtcMock.current = {
      status: 'open',
      detail: '',
      canRetryConnection: false,
      retryConnection: vi.fn(),
      recentSessionsGeneratedAt: '2026-05-05T19:30:00.000Z',
      recentSessionsSupportStatus: 'supported',
      recentSessionsResponseSeq: 1,
      requestRecentSessions: vi.fn(),
      newSessionsSupported: false,
      newSessionDestinationsCatalog: null,
      newSessionDestinationsResponseSeq: 0,
      requestNewSessionDestinations: vi.fn(),
      recentSessions: [
        {
          sessionId: 'session-2',
          sessionKey: 'agent:beta:main',
          agent: 'beta',
          displayLabel: 'Latest-only session',
          lastMessageRole: 'user',
          lastMessagePreview: 'User-only preview line.',
        },
      ],
    };

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession: vi.fn() }));
    });

    expect(container.textContent).toContain('Latest user: User-only preview line.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('formats row activity as short relative time only', () => {
    const now = Date.parse('2026-05-06T17:31:00.000Z');

    expect(formatRelativeActivity('2026-05-06T17:30:45.000Z', now)).toBe('just now');
    expect(formatRelativeActivity('2026-05-06T17:26:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeActivity('2026-05-06T15:31:00.000Z', now)).toBe('2h ago');
    expect(formatRelativeActivity('2026-05-03T17:31:00.000Z', now)).toBe('3d ago');
  });
});

describe('Dashboard new-session flow', () => {
  function makeNewSessionRtcMock() {
    const listeners = new Set<(msg: Record<string, unknown>) => void>();
    const sendControl = vi.fn();
    const requestNewSessionDestinations = vi.fn(() => {
      sendControl({ t: 'sessions.destinations.request' });
    });
    return {
      mock: {
        status: 'open',
        detail: '',
        canRetryConnection: false,
        retryConnection: vi.fn(),
        recentSessionsGeneratedAt: '2026-06-10T00:00:00.000Z',
        recentSessionsSupportStatus: 'supported',
        recentSessionsResponseSeq: 1,
        requestRecentSessions: vi.fn(),
        recentSessions: [],
        newSessionsSupported: true,
        newSessionDestinationsCatalog: null,
        newSessionDestinationsResponseSeq: 0,
        requestNewSessionDestinations,
        sendControl,
        addControlListener: (fn: (msg: Record<string, unknown>) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
      emit(msg: Record<string, unknown>) {
        for (const fn of [...listeners]) fn(msg);
      },
    };
  }

  it('hides the new-session entry point when the daemon does not support session creation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rtcMock.current = {
      ...makeNewSessionRtcMock().mock,
      newSessionsSupported: false,
    };

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession: vi.fn() }));
    });

    expect(container.querySelector('[aria-label="New session"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });


  it('preloads new-session destinations on dashboard open before the chooser is opened', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock } = makeNewSessionRtcMock();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession: vi.fn() }));
    });

    expect(mock.requestNewSessionDestinations).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="New session"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('creates a local web session via chat choice and hands the session to onSelectSession', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock, emit } = makeNewSessionRtcMock();
    const onSelectSession = vi.fn();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession }));
    });

    expect(mock.requestNewSessionDestinations).toHaveBeenCalled();

    const newSessionButton = container.querySelector('[aria-label="New session"]') as HTMLButtonElement;
    expect(newSessionButton).not.toBeNull();
    await act(async () => {
      newSessionButton.click();
    });

    expect(mock.sendControl).toHaveBeenCalledWith({ t: 'sessions.destinations.request' });
    expect(container.textContent).toContain('Web only (no chat channel)');
    expect(container.textContent).toContain('Loading chat destinations in the background…');

    await act(async () => {
      emit({
        t: 'sessions.destinations',
        catalog: {
          generatedAt: '2026-06-10T00:00:00.000Z',
          providers: [
            {
              id: 'webchat',
              label: 'Web only (no chat channel)',
              kind: 'local',
              status: 'available',
              destinations: [],
            },
            {
              // Defensive: a daemon with different emission rules may
              // still send non-available providers — they never render,
              // not even as disabled cards.
              id: 'slack',
              label: 'Slack',
              kind: 'channel',
              status: 'unsupported',
              statusDetail: 'channel_session_creation_unsupported',
              destinations: [
                { id: 'slack:channel:C123', target: 'channel:C123', label: 'slack general' },
              ],
            },
          ],
        },
      });
    });

    expect(container.textContent).toContain('Web only (no chat channel)');
    expect(container.textContent).not.toContain('Slack');
    expect(container.textContent).not.toContain('not supported');

    const providerButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Web only (no chat channel)'),
    );
    expect(providerButtons).toHaveLength(1);

    await act(async () => {
      providerButtons[0].click();
    });

    const createCall = mock.sendControl.mock.calls
      .map(([msg]: [Record<string, unknown>]) => msg)
      .find((msg) => msg.t === 'sessions.create.request');
    expect(createCall).toBeTruthy();
    expect(createCall.providerId).toBe('webchat');
    expect(typeof createCall.requestId).toBe('string');
    expect(container.textContent).toContain('Creating session…');

    const session = {
      sessionId: 'new-session-uuid',
      sessionKey: 'agent:main:webchat:session:new-session-uuid',
      agent: 'main',
      channel: 'webchat',
      displayLabel: 'New web session',
    };
    await act(async () => {
      emit({ t: 'sessions.created', requestId: createCall.requestId, session });
    });

    expect(onSelectSession).toHaveBeenCalledWith(session);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('creates a Discord session by picking a destination and hands it to onSelectSession', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock, emit } = makeNewSessionRtcMock();
    const onSelectSession = vi.fn();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession }));
    });
    await act(async () => {
      (container.querySelector('[aria-label="New session"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      emit({
        t: 'sessions.destinations',
        catalog: {
          generatedAt: '2026-06-10T00:00:00.000Z',
          providers: [
            { id: 'webchat', label: 'Web only (no chat channel)', kind: 'local', status: 'available', destinations: [] },
            {
              id: 'discord',
              label: 'Discord',
              kind: 'channel',
              status: 'available',
              // Real channel-catalog destinations: parent channels with
              // human #names grouped by guild, not recent-session rows.
              destinations: [
                { id: 'discord:channel:100', target: 'channel:100', label: '#general', group: 'Claw HQ' },
                { id: 'discord:channel:200', target: 'channel:200', label: '#design', group: 'Claw HQ', accountId: 'acct-a' },
              ],
            },
          ],
        },
      });
    });

    const discordButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Discord'),
    ) as HTMLButtonElement;
    expect(discordButton.disabled).toBe(false);
    expect(discordButton.textContent).toContain('2 channels');

    await act(async () => {
      discordButton.click();
    });

    const search = container.querySelector('[aria-label="Search destinations"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    // Channel names and the guild group header come from the catalog.
    expect(container.textContent).toContain('#general');
    expect(container.textContent).toContain('#design');
    expect(container.textContent).toContain('CLAW HQ');

    const destinationButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('#design'),
    ) as HTMLButtonElement;
    await act(async () => {
      destinationButton.click();
    });

    const createCall = mock.sendControl.mock.calls
      .map(([msg]: [Record<string, unknown>]) => msg)
      .find((msg) => msg.t === 'sessions.create.request');
    expect(createCall).toBeTruthy();
    expect(createCall.providerId).toBe('discord');
    expect(createCall.target).toBe('channel:200');
    expect(createCall.accountId).toBe('acct-a');
    expect(container.textContent).toContain('Creating session…');

    const session = {
      sessionId: 'new-discord-uuid',
      sessionKey: 'agent:main:discord:channel:t-900',
      agent: 'main',
      channel: 'discord',
      target: 'channel:t-900',
      accountId: 'acct-a',
      displayLabel: 'Voice session — 2026-06-10 01:02',
    };
    await act(async () => {
      emit({ t: 'sessions.created', requestId: createCall.requestId, session });
    });

    expect(onSelectSession).toHaveBeenCalledWith(session);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('creates a Slack session by picking a parent channel and hands it to onSelectSession', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock, emit } = makeNewSessionRtcMock();
    const onSelectSession = vi.fn();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession }));
    });
    await act(async () => {
      (container.querySelector('[aria-label="New session"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      emit({
        t: 'sessions.destinations',
        catalog: {
          generatedAt: '2026-06-10T00:00:00.000Z',
          providers: [
            { id: 'webchat', label: 'Web only (no chat channel)', kind: 'local', status: 'available', destinations: [] },
            {
              id: 'slack',
              label: 'Slack',
              kind: 'channel',
              status: 'available',
              // Real channel-catalog destinations: parent channels with
              // human #names grouped by workspace, not recent-session rows.
              destinations: [
                { id: 'slack:channel:C100', target: 'channel:C100', label: '#general', group: 'Claw HQ' },
                { id: 'slack:channel:C200', target: 'channel:C200', label: '#design', group: 'Claw HQ', accountId: 'acct-s' },
              ],
            },
          ],
        },
      });
    });

    const slackButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Slack'),
    ) as HTMLButtonElement;
    expect(slackButton.disabled).toBe(false);
    expect(slackButton.textContent).toContain('2 channels');

    await act(async () => {
      slackButton.click();
    });

    const search = container.querySelector('[aria-label="Search destinations"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(container.textContent).toContain('#general');
    expect(container.textContent).toContain('#design');
    expect(container.textContent).toContain('CLAW HQ');

    const destinationButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('#design'),
    ) as HTMLButtonElement;
    await act(async () => {
      destinationButton.click();
    });

    const createCall = mock.sendControl.mock.calls
      .map(([msg]: [Record<string, unknown>]) => msg)
      .find((msg) => msg.t === 'sessions.create.request');
    expect(createCall).toBeTruthy();
    expect(createCall.providerId).toBe('slack');
    expect(createCall.target).toBe('channel:C200');
    expect(createCall.accountId).toBe('acct-s');
    expect(container.textContent).toContain('Creating session…');

    const session = {
      sessionId: 'new-slack-uuid',
      sessionKey: 'agent:main:slack:channel:C200:thread:1710000000.000100',
      agent: 'main',
      channel: 'slack',
      target: 'channel:C200',
      accountId: 'acct-s',
      displayLabel: 'Voice session — 2026-06-10 01:02',
    };
    await act(async () => {
      emit({ t: 'sessions.created', requestId: createCall.requestId, session });
    });

    expect(onSelectSession).toHaveBeenCalledWith(session);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('omits providers without real creatable channels instead of showing disabled cards', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock, emit } = makeNewSessionRtcMock();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession: vi.fn() }));
    });
    await act(async () => {
      (container.querySelector('[aria-label="New session"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      emit({
        t: 'sessions.destinations',
        catalog: {
          generatedAt: '2026-06-10T00:00:00.000Z',
          providers: [
            { id: 'webchat', label: 'Web only (no chat channel)', kind: 'local', status: 'available', destinations: [] },
            {
              id: 'discord',
              label: 'Discord',
              kind: 'channel',
              status: 'unavailable',
              statusDetail: 'discord_channel_catalog_unavailable',
              destinations: [],
            },
            {
              // Defensive: available but with no destinations — still omitted.
              id: 'slack',
              label: 'Slack',
              kind: 'channel',
              status: 'available',
              destinations: [],
            },
          ],
        },
      });
    });

    expect(container.textContent).toContain('Web only (no chat channel)');
    expect(container.textContent).not.toContain('Discord');
    expect(container.textContent).not.toContain('Slack');
    expect(container.textContent).not.toContain('unavailable');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('selects only available providers backed by destinations (or the local web option)', () => {
    const catalog = {
      generatedAt: '2026-06-10T00:00:00.000Z',
      providers: [
        { id: 'webchat', label: 'Web only (no chat channel)', kind: 'local' as const, status: 'available' as const, destinations: [] },
        {
          id: 'discord',
          label: 'Discord',
          kind: 'channel' as const,
          status: 'available' as const,
          destinations: [{ id: 'discord:channel:100', target: 'channel:100', label: '#general' }],
        },
        { id: 'slack', label: 'Slack', kind: 'channel' as const, status: 'available' as const, destinations: [] },
        {
          id: 'telegram',
          label: 'Telegram',
          kind: 'channel' as const,
          status: 'unsupported' as const,
          destinations: [{ id: 'telegram:chat:1', target: 'chat:1', label: 'a chat' }],
        },
      ],
    };
    expect(listSelectableNewSessionProviders(catalog).map((provider) => provider.id)).toEqual([
      'webchat',
      'discord',
    ]);
  });

  it('surfaces daemon create errors for the matching request id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const { mock, emit } = makeNewSessionRtcMock();
    const onSelectSession = vi.fn();
    rtcMock.current = mock;

    await act(async () => {
      root.render(createElement(DashboardScreen, { hostPeerId: 'host-1', onSelectSession }));
    });
    await act(async () => {
      (container.querySelector('[aria-label="New session"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      emit({
        t: 'sessions.destinations',
        catalog: {
          generatedAt: '2026-06-10T00:00:00.000Z',
          providers: [
            { id: 'webchat', label: 'Web only (no chat channel)', kind: 'local', status: 'available', destinations: [] },
          ],
        },
      });
    });
    await act(async () => {
      ([...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Web only (no chat channel)'),
      ) as HTMLButtonElement).click();
    });
    const createCall = mock.sendControl.mock.calls
      .map(([msg]: [Record<string, unknown>]) => msg)
      .find((msg) => msg.t === 'sessions.create.request');

    await act(async () => {
      emit({ t: 'sessions.create.error', requestId: 'other-request', message: 'ignored' });
    });
    expect(container.textContent).toContain('Creating session…');

    await act(async () => {
      emit({
        t: 'sessions.create.error',
        requestId: createCall.requestId,
        message: 'new_session_destination_unsupported',
      });
    });
    expect(container.textContent).toContain('The daemon cannot create sessions for that destination.');
    expect(onSelectSession).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('filters and groups channel destinations for the autocomplete picker', () => {
    const destinations = [
      { id: 'discord:channel:t-1', target: 'channel:t-1', label: 'release thread' },
      { id: 'discord:acct-a:channel:t-2', target: 'channel:t-2', label: 'design talk', accountId: 'acct-a', group: 'acct-a' },
      { id: 'discord:acct-a:user:u-1', target: 'user:u-1', label: 'DM pat', accountId: 'acct-a', group: 'acct-a' },
    ];

    expect(filterNewSessionDestinations(destinations, '')).toEqual(destinations);
    expect(filterNewSessionDestinations(destinations, 'design')).toEqual([destinations[1]]);
    expect(filterNewSessionDestinations(destinations, 'T-1')).toEqual([destinations[0]]);
    expect(filterNewSessionDestinations(destinations, 'acct-a')).toEqual([destinations[1], destinations[2]]);
    expect(filterNewSessionDestinations(destinations, 'nope')).toEqual([]);

    expect(groupNewSessionDestinations(destinations)).toEqual([
      { destinations: [destinations[0]] },
      { group: 'acct-a', destinations: [destinations[1], destinations[2]] },
    ]);
  });

  it('formats daemon create error codes as readable copy', () => {
    expect(formatNewSessionCreateError('new_session_destination_unsupported')).toBe(
      'The daemon cannot create sessions for that destination.',
    );
    expect(formatNewSessionCreateError('invalid_new_session_request')).toBe(
      'The daemon rejected the new-session request.',
    );
    expect(formatNewSessionCreateError('invalid_new_session_target')).toBe(
      'The daemon rejected the new-session request.',
    );
    expect(formatNewSessionCreateError('discord_thread_create_failed')).toBe(
      'The daemon could not create the Discord thread.',
    );
    expect(formatNewSessionCreateError('discord_thread_id_unresolved')).toBe(
      'Discord did not return a usable thread id.',
    );
    expect(formatNewSessionCreateError('new_session_timeout')).toBe('No response from the daemon. Try again.');
    expect(formatNewSessionCreateError('boom')).toBe('Session creation failed: boom');
    expect(formatNewSessionCreateError(undefined)).toBe('Session creation failed.');
  });
});

describe('Dashboard favorite session markers', () => {
  it('does not render or wire favorite toggle controls in the sessions list', () => {
    expect(source).not.toContain('onToggleFavorite');
    expect(source).not.toContain('rtc.toggleRecentSessionFavorite');
    expect(source).not.toContain('aria-pressed');
    expect(source).not.toContain("{favorite ? '★' : '☆'}");
    expect(source).toContain("{session.persistedFavorite && <span>SAVED</span>}");
    expect(source).toContain('gridTemplateColumns: \'minmax(0, 1fr)\'');
  });
});
