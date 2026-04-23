// Thin public rendezvous for Clawkie-Talkie WebRTC signaling.
//
// Carries SDP + ICE candidates between phone and daemon, keyed by a
// shared token. Stateless per-session: no media, no keys, no transcripts
// ever traverse this service. In-memory rooms; TTL GC.
//
// Endpoints:
//   POST /rooms                       — { token } → 201 { ok: true }
//   GET  /rooms/:token/subscribe      — SSE stream, events:
//     event: assigned       data: { id }
//     event: peer-present   data: { id }          (one per existing peer on connect)
//     event: peer-joined    data: { id }          (broadcast when someone else joins)
//     event: peer-left      data: { id }
//     event: signal         data: { from, data }
//   POST /rooms/:token/signal         — { from, data } → broadcast to others as `signal`
//   DELETE /rooms/:token              — optional teardown
//
// No auth: the token acts as the shared secret. Tokens expire after
// ROOM_TTL_MS of inactivity (no subscribers + no recent signal).

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = 15 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;

interface Subscriber {
  id: string;
  res: http.ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

interface Room {
  createdAt: number;
  lastActivity: number;
  subscribers: Map<string, Subscriber>;
}

const rooms = new Map<string, Room>();

setInterval(() => {
  const now = Date.now();
  for (const [token, room] of rooms) {
    if (room.subscribers.size === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(token);
    }
  }
}, GC_INTERVAL_MS).unref();

function touch(room: Room) {
  room.lastActivity = Date.now();
}

function getOrCreateRoom(token: string): Room {
  const existing = rooms.get(token);
  if (existing) return existing;
  const fresh: Room = { createdAt: Date.now(), lastActivity: Date.now(), subscribers: new Map() };
  rooms.set(token, fresh);
  return fresh;
}

function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendSse(res: http.ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client gone — cleanup happens in 'close' handler
  }
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as T;
}

const ROOM_PATH_RE = /^\/rooms\/([^/]+)(\/subscribe|\/signal)?$/;

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/rooms') {
      const body = await readJsonBody<{ token?: string }>(req).catch(
        (): { token?: string } => ({}),
      );
      const token = body.token?.trim();
      if (!token) {
        res.statusCode = 400;
        return res.end('missing token');
      }
      getOrCreateRoom(token);
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const match = url.pathname.match(ROOM_PATH_RE);
    if (match) {
      const token = decodeURIComponent(match[1]);
      const tail = match[2];

      if (req.method === 'DELETE' && !tail) {
        rooms.delete(token);
        res.statusCode = 204;
        return res.end();
      }

      if (req.method === 'GET' && tail === '/subscribe') {
        const room = getOrCreateRoom(token);
        touch(room);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        const id = randomUUID();
        const heartbeat = setInterval(() => {
          try {
            res.write(':hb\n\n');
          } catch {
            // ignore
          }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        const sub: Subscriber = { id, res, heartbeat };
        room.subscribers.set(id, sub);

        sendSse(res, 'assigned', { id });
        for (const [otherId, other] of room.subscribers) {
          if (otherId === id) continue;
          sendSse(res, 'peer-present', { id: otherId });
          sendSse(other.res, 'peer-joined', { id });
        }

        req.on('close', () => {
          clearInterval(heartbeat);
          room.subscribers.delete(id);
          touch(room);
          for (const other of room.subscribers.values()) {
            sendSse(other.res, 'peer-left', { id });
          }
        });
        return;
      }

      if (req.method === 'POST' && tail === '/signal') {
        const room = rooms.get(token);
        if (!room) {
          res.statusCode = 404;
          return res.end('no such room');
        }
        const body = await readJsonBody<{ from?: string; data?: unknown }>(req).catch(
          (): { from?: string; data?: unknown } => ({}),
        );
        if (!body.from || body.data === undefined) {
          res.statusCode = 400;
          return res.end('missing from/data');
        }
        touch(room);
        for (const [id, sub] of room.subscribers) {
          if (id === body.from) continue;
          sendSse(sub.res, 'signal', { from: body.from, data: body.data });
        }
        res.statusCode = 204;
        return res.end();
      }
    }

    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    console.error('[rendezvous]', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[rendezvous] listening on http://${HOST}:${PORT}`);
});
