import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatRelativeActivity } from '../client/src/screens/Dashboard';

const source = readFileSync(new URL('../client/src/screens/Dashboard.tsx', import.meta.url), 'utf8');

describe('Dashboard session discovery state guards', () => {
  it('does not render timeout or unsupported notices after any recent-session response exists', () => {
    expect(source).toContain('const hasRecentSessionResponse = rtc.recentSessions.length > 0 || !!rtc.recentSessionsGeneratedAt;');
    expect(source).toContain("const showUnsupported = supportStatus === 'unsupported' && !hasRecentSessionResponse;");
    expect(source).toContain('const showTimedOut = refresh.timedOut && !hasRecentSessionResponse;');
    expect(source).toContain('{showTimedOut && <Notice tone="warn">No recent-session response yet. The daemon may still be starting.</Notice>}');
    expect(source).toContain('{showUnsupported && <Notice tone="warn">This daemon does not support host dashboard session discovery.</Notice>}');
  });

  it('keeps the empty unsupported state behind the same guarded flag', () => {
    expect(source).toContain('unsupported={showUnsupported}');
    expect(source).toContain("? 'Session discovery is unavailable for this daemon.'");
  });

  it('uses the full product name in the dashboard label', () => {
    expect(source).toContain('CLAWKIE-TALKIE DASHBOARD');
    expect(source).not.toContain('CLAWKIE DASHBOARD');
  });

  it('uses a slower startup timeout for the host dashboard refresh notice', () => {
    expect(source).toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 12_000;');
    expect(source).not.toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 3500;');
  });
});


describe('Dashboard recent session row labels', () => {
  it('orders the session info bar as agent, channel, relative time', () => {
    const agentIndex = source.indexOf("<span>{session.agent || 'unknown'}</span>");
    const channelIndex = source.indexOf("{session.channel && <span>{session.channel}</span>}");
    const timeIndex = source.indexOf("{session.lastActivity && <span>{formatRelativeActivity(session.lastActivity)}</span>}");

    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(channelIndex).toBeGreaterThan(agentIndex);
    expect(timeIndex).toBeGreaterThan(channelIndex);
    expect(source).not.toContain('formatActivity(session.lastActivity)');
  });

  it('formats row activity as short relative time only', () => {
    const now = Date.parse('2026-05-06T17:31:00.000Z');

    expect(formatRelativeActivity('2026-05-06T17:30:45.000Z', now)).toBe('just now');
    expect(formatRelativeActivity('2026-05-06T17:26:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeActivity('2026-05-06T15:31:00.000Z', now)).toBe('2h ago');
    expect(formatRelativeActivity('2026-05-03T17:31:00.000Z', now)).toBe('3d ago');
  });
});
