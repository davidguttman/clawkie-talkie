import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SignalingAppOptions {
  pingIntervalMs?: number;
  maxIdLength?: number;
  maxRoomLength?: number;
  maxSubscribersPerRoom?: number;
  maxSubscribersTotal?: number;
}

export interface SignalingApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  closeAllSubscribers: () => void;
  readonly subscriberCount: number;
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface Subscriber {
  id: string;
  peerId: string;
  room: string;
  res: ServerResponse;
  ping: NodeJS.Timeout;
}

interface SignalEnvelope {
  from: string;
  to: string;
  data: unknown;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ID_LENGTH = 128;
const DEFAULT_MAX_ROOM_LENGTH = 256;
const DEFAULT_MAX_SUBSCRIBERS_PER_ROOM = 128;
const DEFAULT_MAX_SUBSCRIBERS_TOTAL = 2_048;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function createSignalingApp(opts: SignalingAppOptions = {}): RequestHandler {
  return createSignalingService(opts).handler;
}

export function createSignalingService(opts: SignalingAppOptions = {}): SignalingApp {
  const rooms = new Map<string, Map<string, Subscriber>>();
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const maxIdLength = opts.maxIdLength ?? DEFAULT_MAX_ID_LENGTH;
  const maxRoomLength = opts.maxRoomLength ?? DEFAULT_MAX_ROOM_LENGTH;
  const maxSubscribersPerRoom = opts.maxSubscribersPerRoom ?? DEFAULT_MAX_SUBSCRIBERS_PER_ROOM;
  const maxSubscribersTotal = opts.maxSubscribersTotal ?? DEFAULT_MAX_SUBSCRIBERS_TOTAL;
  let subscriberCount = 0;

  const closeSubscriber = (subscriber: Subscriber): void => {
    clearInterval(subscriber.ping);
    const subscribers = rooms.get(subscriber.room);
    if (subscribers?.delete(subscriber.id)) subscriberCount -= 1;
    if (subscribers && subscribers.size === 0) rooms.delete(subscriber.room);
    subscriber.res.end();
  };

  const closeAllSubscribers = (): void => {
    for (const subscribers of rooms.values()) {
      for (const subscriber of subscribers.values()) closeSubscriber(subscriber);
    }
  };

  const handler: RequestHandler = (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/subscribe') {
      handleSubscribe({
        req,
        res,
        url,
        rooms,
        pingIntervalMs,
        maxIdLength,
        maxRoomLength,
        maxSubscribersPerRoom,
        maxSubscribersTotal,
        getSubscriberCount: () => subscriberCount,
        incrementSubscriberCount: () => {
          subscriberCount += 1;
        },
        decrementSubscriberCount: () => {
          subscriberCount -= 1;
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/signal') {
      void handleSignal({ req, res, url, rooms, maxIdLength, maxRoomLength });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  };

  return {
    handler,
    closeAllSubscribers,
    get subscriberCount() {
      return subscriberCount;
    },
  };
}

function handleSubscribe(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  rooms: Map<string, Map<string, Subscriber>>;
  pingIntervalMs: number;
  maxIdLength: number;
  maxRoomLength: number;
  maxSubscribersPerRoom: number;
  maxSubscribersTotal: number;
  getSubscriberCount: () => number;
  incrementSubscriberCount: () => void;
  decrementSubscriberCount: () => void;
}): void {
  const peerId = input.url.searchParams.get('id')?.trim();
  const room = input.url.searchParams.get('room')?.trim();
  const paramsError = validatePeerAndRoom(peerId, room, input.maxIdLength, input.maxRoomLength);
  if (paramsError) {
    sendJson(input.res, paramsError.status, { error: paramsError.message });
    return;
  }

  const safePeerId = peerId!;
  const safeRoom = room!;
  let subscribers = input.rooms.get(safeRoom);
  const roomSize = subscribers?.size ?? 0;
  if (input.getSubscriberCount() >= input.maxSubscribersTotal) {
    sendJson(input.res, 429, { error: 'Too many subscribers' });
    return;
  }
  if (roomSize >= input.maxSubscribersPerRoom) {
    sendJson(input.res, 429, { error: 'Too many subscribers in room' });
    return;
  }

  input.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  input.res.flushHeaders?.();

  if (!subscribers) {
    subscribers = new Map();
    input.rooms.set(safeRoom, subscribers);
  }

  const id = randomUUID();

  // Match rambly's contract: the newly subscribed peer is announced to
  // already-connected subscribers in the same room, but not echoed to
  // the new connection itself.
  for (const subscriber of subscribers.values()) {
    if (subscriber.id !== id) writeSse(subscriber.res, 'announce', safePeerId);
  }

  const ping = setInterval(() => {
    writeSse(input.res, 'ping', String(Date.now()));
  }, input.pingIntervalMs);
  ping.unref?.();

  const subscriber: Subscriber = { id, peerId: safePeerId, room: safeRoom, res: input.res, ping };
  subscribers.set(id, subscriber);
  input.incrementSubscriberCount();

  input.res.once('close', () => {
    clearInterval(ping);
    const current = input.rooms.get(safeRoom);
    if (current?.delete(id)) input.decrementSubscriberCount();
    if (current && current.size === 0) input.rooms.delete(safeRoom);
  });
}

async function handleSignal(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  rooms: Map<string, Map<string, Subscriber>>;
  maxIdLength: number;
  maxRoomLength: number;
}): Promise<void> {
  const room = input.url.searchParams.get('room')?.trim();
  const roomError = validateRoom(room, input.maxRoomLength);
  if (roomError) {
    sendJson(input.res, roomError.status, { error: roomError.message });
    return;
  }

  let payload: SignalEnvelope;
  try {
    payload = validateSignalEnvelope(await readJsonBody(input.req), input.maxIdLength);
  } catch (err) {
    sendJson(input.res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  input.res.writeHead(201, { 'Content-Type': 'application/json' });
  input.res.end(JSON.stringify({ ok: true }));

  const subscribers = input.rooms.get(room!);
  if (!subscribers) return;
  const encoded = JSON.stringify(payload);
  for (const subscriber of subscribers.values()) {
    if (subscriber.peerId === payload.to) writeSse(subscriber.res, 'signal', encoded);
  }
}

function validateSignalEnvelope(value: unknown, maxIdLength: number): SignalEnvelope {
  if (!value || typeof value !== 'object') {
    throw new Error('Signal body must be a JSON object');
  }
  const body = value as { from?: unknown; to?: unknown; data?: unknown };
  if (typeof body.from !== 'string' || !body.from.trim()) {
    throw new Error('Signal body missing from');
  }
  if (typeof body.to !== 'string' || !body.to.trim()) {
    throw new Error('Signal body missing to');
  }
  const from = body.from.trim();
  const to = body.to.trim();
  if (from.length > maxIdLength) throw new Error('Signal body from is too long');
  if (to.length > maxIdLength) throw new Error('Signal body to is too long');
  return { from, to, data: body.data ?? {} };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new Error('Missing JSON body');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function validatePeerAndRoom(
  peerId: string | undefined,
  room: string | undefined,
  maxIdLength: number,
  maxRoomLength: number,
): { status: number; message: string } | null {
  if (!peerId || !room) return { status: 400, message: 'Missing id or room' };
  const idError = validateIdentifier('id', peerId, maxIdLength);
  if (idError) return idError;
  return validateRoom(room, maxRoomLength);
}

function validateRoom(
  room: string | undefined,
  maxRoomLength: number,
): { status: number; message: string } | null {
  if (!room) return { status: 400, message: 'Missing room' };
  return validateIdentifier('room', room, maxRoomLength);
}

function validateIdentifier(
  name: string,
  value: string,
  maxLength: number,
): { status: number; message: string } | null {
  if (value.length > maxLength) return { status: 413, message: `${name} is too long` };
  return null;
}

function writeSse(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  for (const line of data.split('\n')) res.write(`data: ${line}\n`);
  res.write('\n');
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
