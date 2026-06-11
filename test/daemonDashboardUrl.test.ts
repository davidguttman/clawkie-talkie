import { describe, expect, it } from 'vitest';
import { formatDashboardJoinUrl } from '../daemon/src/dashboardUrl';
import { parseHostDashboardUrl } from '../client/src/voice/handoffUrl';

describe('daemon dashboard URL formatting', () => {
  it('prints the canonical runtime dashboard entrypoint with hash-scoped host id', () => {
    const url = formatDashboardJoinUrl('https://clawkietalkie.app/', 'host 1');

    expect(url).toBe('https://clawkietalkie.app/dashboard/#host=host+1');
    expect(parseHostDashboardUrl(url)).toEqual({ hostPeerId: 'host 1' });
  });
});
