import http, { type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSignalingApp, createSignalingService } from '../signaling/src/app';

interface TestServer {
  server: Server;
  baseUrl: string;
}

async function startTestServer(pingIntervalMs = 5_000): Promise<TestServer> {
  const server = http.createServer(createSignalingApp({ pingIntervalMs }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('missing server address');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function subscribe(baseUrl: string, peerId: string, room = 'room-a') {
  const controller = new AbortController();
  const res = await fetch(
    `${baseUrl}/subscribe?id=${encodeURIComponent(peerId)}&room=${encodeURIComponent(room)}`,
    { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  if (!res.body) throw new Error('subscribe response missing body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function nextEvent(timeoutMs = 500): Promise<{ event: string; data: string }> {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split('\n');
          let event = 'message';
          const data: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          return { event, data: data.join('\n') };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed before event');
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { controller, nextEvent };
}

async function noEvent(stream: Awaited<ReturnType<typeof subscribe>>, timeoutMs = 10): Promise<void> {
  await expect(stream.nextEvent(timeoutMs)).rejects.toThrow(/abort/i);
}

describe('repo-local rambly-compatible signaling server', () => {
  let testServer: TestServer;
  const streams: Array<{ controller: AbortController }> = [];

  beforeEach(async () => {
    testServer = await startTestServer();
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.controller.abort();
    await closeServer(testServer.server);
  });

  it('responds to health checks and CORS preflight', async () => {
    const health = await fetch(`${testServer.baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const options = await fetch(`${testServer.baseUrl}/signal?room=r`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('announces a new subscriber only to existing subscribers in the same room', async () => {
    const a = await subscribe(testServer.baseUrl, 'peer-a', 'room-a');
    streams.push(a);
    const b = await subscribe(testServer.baseUrl, 'peer-b', 'room-a');
    streams.push(b);
    const c = await subscribe(testServer.baseUrl, 'peer-c', 'room-b');
    streams.push(c);

    await expect(a.nextEvent()).resolves.toEqual({ event: 'announce', data: 'peer-b' });
    await noEvent(b);
    await noEvent(c);
  });

  it('relays POST /signal only to matching target peer in the same room', async () => {
    const a = await subscribe(testServer.baseUrl, 'peer-a', 'room-a');
    const b = await subscribe(testServer.baseUrl, 'peer-b', 'room-a');
    const samePeerDifferentRoom = await subscribe(testServer.baseUrl, 'peer-b', 'room-b');
    streams.push(a, b, samePeerDifferentRoom);
    await a.nextEvent(); // announcement for peer-b in room-a

    const payload = { from: 'peer-a', to: 'peer-b', data: { type: 'offer', sdp: 'v=0' } };
    const post = await fetch(`${testServer.baseUrl}/signal?room=room-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(201);

    await expect(b.nextEvent()).resolves.toEqual({
      event: 'signal',
      data: JSON.stringify(payload),
    });
    await noEvent(a);
    await noEvent(samePeerDifferentRoom);
  });



  it('rejects overlong ids and subscriber caps', async () => {
    await closeServer(testServer.server);
    const app = createSignalingApp({ maxIdLength: 8, maxRoomLength: 8, maxSubscribersPerRoom: 1 });
    testServer.server = http.createServer(app);
    await new Promise<void>((resolve) => testServer.server.listen(0, '127.0.0.1', resolve));
    const addr = testServer.server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing server address');
    testServer.baseUrl = `http://127.0.0.1:${addr.port}`;

    const tooLong = await fetch(`${testServer.baseUrl}/subscribe?id=${'x'.repeat(9)}&room=room-a`);
    expect(tooLong.status).toBe(413);

    const first = await subscribe(testServer.baseUrl, 'peer-a', 'room-a');
    streams.push(first);
    const capped = await fetch(`${testServer.baseUrl}/subscribe?id=peer-b&room=room-a`);
    expect(capped.status).toBe(429);
  });

  it('service.closeAllSubscribers closes open SSE streams before server shutdown', async () => {
    await closeServer(testServer.server);
    const signaling = createSignalingService({ pingIntervalMs: 5_000 });
    testServer.server = http.createServer(signaling.handler);
    await new Promise<void>((resolve) => testServer.server.listen(0, '127.0.0.1', resolve));
    const addr = testServer.server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing server address');
    testServer.baseUrl = `http://127.0.0.1:${addr.port}`;

    const stream = await subscribe(testServer.baseUrl, 'peer-a', 'room-a');
    streams.push(stream);
    expect(signaling.subscriberCount).toBe(1);

    signaling.closeAllSubscribers();
    expect(signaling.subscriberCount).toBe(0);
    const closePromise = once(testServer.server, 'close');
    testServer.server.close();
    await closePromise;
  });

  it('sends periodic ping SSE events', async () => {
    await closeServer(testServer.server);
    testServer = await startTestServer(25);
    const a = await subscribe(testServer.baseUrl, 'peer-a', 'room-a');
    streams.push(a);
    const event = await a.nextEvent(250);
    expect(event.event).toBe('ping');
    expect(Number(event.data)).toBeGreaterThan(0);
  });
});
