// Minimal SSE+POST signaling server (rambly-style).
//
// Two endpoints:
//   GET  /subscribe?id=<peerId>&room=<room>  — long-lived SSE stream
//   POST /signal?room=<room>                 — body: {from, to, data}
//
// SSE events emitted:
//   event: announce  data: <peerId>             // a new peer joined
//   event: signal    data: {from, to, data}     // forwarded signaling
//
// Rules:
//   - When peer X subscribes to room R, every other current subscriber
//     of R receives `announce(X)`. (Per the rambly convention, the
//     existing peer that receives the announce initiates the WebRTC
//     connection.)
//   - POST /signal is forwarded only to the `to` peer (not broadcast).
//
// State is in-memory; restart drops everyone. Fine for local dev and
// small deployments. CORS is permissive so any origin can connect.
//
// Configure via env:
//   PORT          (default 8787)
//   SIGNAL_HOST   (default 0.0.0.0)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface Subscriber {
  id: string;
  res: ServerResponse;
}

const rooms = new Map<string, Map<string, Subscriber>>(); // room -> peerId -> Subscriber

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.SIGNAL_HOST || '0.0.0.0';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

function writeSse(res: ServerResponse, event: string, data: string): void {
  // SSE wire format: data may contain newlines; split each.
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
}

function handleSubscribe(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const id = url.searchParams.get('id');
  const room = url.searchParams.get('room');
  if (!id || !room) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('id and room are required');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });
  // Initial flush so proxies open the stream.
  res.write(': ok\n\n');

  let bucket = rooms.get(room);
  if (!bucket) {
    bucket = new Map<string, Subscriber>();
    rooms.set(room, bucket);
  }

  // If a subscriber with the same id is already connected, drop the old
  // one so reconnects work cleanly.
  const previous = bucket.get(id);
  if (previous) {
    try { previous.res.end(); } catch { /* ignore */ }
  }

  bucket.set(id, { id, res });
  console.log(`[signal] subscribe room=${room} id=${id} (peers=${bucket.size})`);

  // Announce this new peer to every existing subscriber.
  for (const [peerId, sub] of bucket) {
    if (peerId === id) continue;
    try { writeSse(sub.res, 'announce', id); } catch { /* ignore */ }
  }

  // Heartbeat to keep proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    const current = rooms.get(room);
    if (!current) return;
    if (current.get(id)?.res === res) {
      current.delete(id);
      if (current.size === 0) rooms.delete(room);
      console.log(`[signal] unsubscribe room=${room} id=${id} (peers=${current.size})`);
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // Cap at ~256KB — signaling payloads are small.
    if (chunks.reduce((n, c) => n + c.length, 0) > 256 * 1024) {
      throw new Error('payload_too_large');
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleSignal(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const room = url.searchParams.get('room');
  if (!room) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('room is required');
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('payload too large');
    return;
  }

  let payload: { from?: string; to?: string; data?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('invalid JSON');
    return;
  }

  const { from, to, data } = payload;
  if (typeof from !== 'string' || typeof to !== 'string' || data === undefined) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('from, to, data are required');
    return;
  }

  const bucket = rooms.get(room);
  const target = bucket?.get(to);
  if (target) {
    try {
      writeSse(target.res, 'signal', JSON.stringify({ from, to, data }));
    } catch (err) {
      console.error(`[signal] forward failed room=${room} to=${to}: ${err}`);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify({ delivered: !!target }));
}

const server = createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders() });
    res.end('bad request');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/subscribe') {
    handleSubscribe(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/signal') {
    void handleSignal(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders() });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[signal] listening on http://${HOST}:${PORT}`);
});
