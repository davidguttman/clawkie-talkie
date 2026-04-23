// Browser signaling client — SSE subscribe + POST signal against the
// Clawkie-Talkie rendezvous. Mirrors the daemon's shape so both peers
// see the same control plane.

export interface SseMessage {
  event: string;
  data: { id?: string; from?: string; data?: unknown };
}

export type SseHandler = (msg: SseMessage) => void;

export class RendezvousClient {
  private aborter = new AbortController();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly selfId: string,
  ) {}

  subscribe(handler: SseHandler, onError?: (err: Error) => void): void {
    const url = `${this.baseUrl}/rooms/${encodeURIComponent(this.token)}/subscribe`;
    fetch(url, { signal: this.aborter.signal, headers: { Accept: 'text/event-stream' } })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          throw new Error(`rendezvous subscribe failed: ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventName = 'message';
        let dataLines: string[] = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line === '') {
              if (dataLines.length) {
                try {
                  handler({
                    event: eventName,
                    data: JSON.parse(dataLines.join('\n')) as SseMessage['data'],
                  });
                } catch {
                  // ignore malformed frame
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
      })
      .catch((err: unknown) => {
        if (this.aborter.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async sendSignal(data: unknown): Promise<void> {
    const url = `${this.baseUrl}/rooms/${encodeURIComponent(this.token)}/signal`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.selfId, data }),
    });
    if (!res.ok) throw new Error(`rendezvous signal failed: ${res.status}`);
  }

  close(): void {
    this.aborter.abort();
  }
}
