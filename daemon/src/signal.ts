// Minimal signaling client — talks to a rambly-style server via SSE
// (subscribe) and HTTP POST (send signal). Used by the daemon to find
// the phone in a shared room (room name = daemon UUID).
//
// Mirrors client/src/rtc/signal.ts. Kept in two places to avoid a
// shared package; both files use only the platform fetch + ReadableStream.

import { EventEmitter } from 'node:events';

export type SignalData = Record<string, unknown>;

export interface AnnounceEvent {
  peerId: string;
}

export interface SignalEvent {
  from: string;
  to: string;
  data: SignalData;
}

export interface SignalClientEvents {
  announce: [AnnounceEvent];
  signal: [SignalEvent];
  error: [Error];
  close: [];
  open: [];
}

export interface SignalClientOptions {
  signalServer: string;
  peerId: string;
  roomName: string;
  maxReconnectDelay?: number;
  baseReconnectDelay?: number;
}

async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let currentData: string[] = [];

  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line === '') {
        if (currentData.length > 0) {
          yield { event: currentEvent, data: currentData.join('\n') };
        }
        currentEvent = 'message';
        currentData = [];
      } else if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trimStart());
      }
    }
  }

  if (currentData.length > 0) {
    yield { event: currentEvent, data: currentData.join('\n') };
  }
}

export class SignalClient extends EventEmitter<SignalClientEvents> {
  private readonly signalServer: string;
  private readonly peerId: string;
  private readonly roomName: string;
  private readonly maxReconnectDelay: number;
  private readonly baseReconnectDelay: number;

  private abortController: AbortController | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: SignalClientOptions) {
    super();
    this.signalServer = opts.signalServer.replace(/\/+$/, '');
    this.peerId = opts.peerId;
    this.roomName = opts.roomName;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? 30_000;
    this.baseReconnectDelay = opts.baseReconnectDelay ?? 1_000;
  }

  subscribe(): void {
    if (this.closed) return;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.emit('close');
  }

  async sendSignal(to: string, data: SignalData): Promise<void> {
    const url = `${this.signalServer}/signal?room=${encodeURIComponent(this.roomName)}`;
    const body = JSON.stringify({ from: this.peerId, to, data });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      throw new Error(`sendSignal failed: ${res.status} ${res.statusText}`);
    }
  }

  private connect(): void {
    if (this.closed) return;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const url = `${this.signalServer}/subscribe?id=${encodeURIComponent(this.peerId)}&room=${encodeURIComponent(this.roomName)}`;

    fetch(url, {
      signal,
      headers: { Accept: 'text/event-stream' },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`SSE subscribe failed: ${res.status} ${res.statusText}`);
        }
        if (!res.body) {
          throw new Error('SSE response has no body');
        }

        this.reconnectAttempt = 0;
        this.emit('open');

        for await (const msg of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
          if (this.closed) return;
          this.handleSseMessage(msg);
        }

        if (!this.closed) {
          this.scheduleReconnect();
        }
      })
      .catch((err: unknown) => {
        if (this.closed) return;
        if (err instanceof Error && err.name === 'AbortError') return;

        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.scheduleReconnect();
      });
  }

  private handleSseMessage(msg: { event: string; data: string }): void {
    try {
      switch (msg.event) {
        case 'announce': {
          const peerId = msg.data.trim();
          if (peerId && peerId !== this.peerId) {
            this.emit('announce', { peerId });
          }
          break;
        }
        case 'signal': {
          const payload = JSON.parse(msg.data) as SignalEvent;
          if (payload.to === this.peerId) {
            this.emit('signal', payload);
          }
          break;
        }
      }
    } catch {
      // Malformed payload — skip
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = Math.min(
      this.baseReconnectDelay * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
  }
}
