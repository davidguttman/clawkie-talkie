import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('uses a slower startup timeout for the host dashboard refresh notice', () => {
    expect(source).toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 12_000;');
    expect(source).not.toContain('const DASHBOARD_REFRESH_TIMEOUT_MS = 3500;');
  });
});
