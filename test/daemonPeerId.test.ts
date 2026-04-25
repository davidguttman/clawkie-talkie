import { describe, expect, it } from 'vitest';
import { resolveDaemonPeerId } from '../daemon/src/peerId';

describe('daemon peer id', () => {
  it('uses DAEMON_PEER_ID only as an explicit override', () => {
    expect(resolveDaemonPeerId({ DAEMON_PEER_ID: '  dev-peer  ' } as NodeJS.ProcessEnv)).toBe(
      'dev-peer',
    );
  });

  it('generates a UUID when no override is configured', () => {
    expect(resolveDaemonPeerId({} as NodeJS.ProcessEnv)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
