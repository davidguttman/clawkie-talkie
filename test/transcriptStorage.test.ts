import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('transcript storage', () => {
  it('persists user and assistant turns under a local session', async () => {
    const { appendTranscriptTurn, latestAssistantText, listTranscriptSessions, loadTranscriptSession } =
      await import('../client/src/storage');
    const now = new Date('2026-04-27T12:00:00.000Z');

    appendTranscriptTurn(
      { sessionId: 'session-1', threadId: '1498445515283632169', now },
      { role: 'user', text: 'hello' },
    );
    appendTranscriptTurn(
      { sessionId: 'session-1', threadId: '1498445515283632169', now },
      { role: 'assistant', text: 'hi there' },
    );

    const session = loadTranscriptSession('session-1');
    expect(session?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
    expect(latestAssistantText(session)).toBe('hi there');
    expect(listTranscriptSessions()[0]).toMatchObject({
      id: 'session-1',
      threadId: '1498445515283632169',
      turnCount: 2,
      preview: 'AI: hi there',
    });
  });

  it('exports markdown, text, and json with timestamp settings applied', async () => {
    const { appendTranscriptTurn, exportTranscript, loadTranscriptSession } = await import(
      '../client/src/storage'
    );
    const now = new Date('2026-04-27T12:00:00.000Z');
    appendTranscriptTurn({ sessionId: 'session-1', now }, { role: 'user', text: 'hello' });
    const session = loadTranscriptSession('session-1')!;

    expect(exportTranscript(session, { format: 'md', timestamps: false }).body).toContain(
      '**You**\n\nhello',
    );
    expect(exportTranscript(session, { format: 'txt', timestamps: false }).body).toContain(
      'You: hello',
    );
    const json = exportTranscript(session, { format: 'json', timestamps: false }).body;
    expect(JSON.parse(json).turns[0]).toEqual({ role: 'user', text: 'hello' });

    const timestamped = JSON.parse(
      exportTranscript(session, { format: 'json', timestamps: true }).body,
    );
    expect(timestamped.turns[0].createdAt).toBe('2026-04-27T12:00:00.000Z');
  });
});
