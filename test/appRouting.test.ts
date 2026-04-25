import { describe, expect, it } from 'vitest';
import { parseInitialSearch } from '../client/src/app';

describe('client URL parsing', () => {
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
