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

import { DashboardScreen, formatRelativeActivity } from '../client/src/screens/Dashboard';

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
