import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatRelativeActivity } from '../client/src/screens/Dashboard';

const source = readFileSync(new URL('../client/src/screens/Dashboard.tsx', import.meta.url), 'utf8');

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

  it('uses the full product name in the dashboard label', () => {
    expect(source).toContain('CLAWKIE-TALKIE DASHBOARD');
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
