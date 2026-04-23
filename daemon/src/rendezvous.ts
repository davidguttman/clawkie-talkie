// Daemon-side rendezvous client: registers the room, subscribes to SSE,
// relays signal frames. Mirrors the browser client's shape.

import { EventEmitter } from 'node:events';

export interface SseMessage {
  event: string;
  data: unknown;
}

export class RendezvousClient extends EventEmitter {
  private aborter: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly selfId: string,
  ) {
    super();
  }

  async register(): Promise<void> {
    const res = await fetch(`${this.base}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token }),
    });
    if (!res.ok && res.status !== 201) {
      throw new Error(`rendezvous register failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  async sendSignal(data: unknown): Promise<void> {
    const url = `${this.base}/rooms/${encodeURIComponent(this.token)}/signal`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.selfId, data }),
    });
    if (!res.ok) {
      throw new Error(`rendezvous signal failed: ${res.status}`);
    }
  }

  subscribe(): void {
    if (this.closed) return;
    this.aborter = new AbortController();
    const signal = this.aborter.signal;
    const url = `${this.base}/rooms/${encodeURIComponent(this.token)}/subscribe`;

    (async () => {
      const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) {
        this.emit('error', new Error(`rendezvous subscribe failed: ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line === '') {
            if (dataLines.length) {
              try {
                this.emit('sse', {
                  event: eventName,
                  data: JSON.parse(dataLines.join('\n')),
                } satisfies SseMessage);
              } catch {
                // ignore malformed
              }
            }
            eventName = 'message';
            dataLines = [];
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    })().catch((err) => {
      if (!signal.aborted) this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  close(): void {
    this.closed = true;
    this.aborter?.abort();
    this.aborter = null;
  }
}
