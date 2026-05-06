import { execFile } from 'node:child_process';
import type { RecentSession, RecentSessionsSnapshot } from './protocol.js';

export const DEFAULT_RECENT_SESSIONS_TTL_MS = 60_000;
export const DEFAULT_RECENT_SESSIONS_LIMIT = 10;
const RECENT_SESSIONS_ACTIVE_MINUTES = 10_080;

export interface RecentSessionsCacheOptions {
  loadSessions: () => Promise<RecentSessionsSnapshot>;
  ttlMs: number;
  now?: () => number;
}

export interface RecentSessionsCache {
  get(): Promise<RecentSessionsSnapshot>;
}

export interface BuildRecentSessionsOptions {
  limit?: number;
  generatedAt?: string;
  resolveDisplayLabel?: (session: RecentSession) => Promise<string | undefined>;
}

interface OpenClawSessionsJson {
  sessions?: unknown[];
}

function execOpenClaw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('openclaw', args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function createEmptyRecentSessionsSnapshot(generatedAt = new Date().toISOString()): RecentSessionsSnapshot {
  return { generatedAt, sessions: [] };
}

export function createRecentSessionsCache(options: RecentSessionsCacheOptions): RecentSessionsCache {
  let cached: RecentSessionsSnapshot | undefined;
  let expiresAt = 0;
  const now = options.now ?? Date.now;

  return {
    async get(): Promise<RecentSessionsSnapshot> {
      const ts = now();
      if (cached && ts < expiresAt) return cached;

      try {
        cached = await options.loadSessions();
      } catch {
        cached ??= createEmptyRecentSessionsSnapshot(new Date(ts).toISOString());
      }
      expiresAt = now() + options.ttlMs;
      return cached;
    },
  };
}

export async function getRecentSessionsWithOpenClaw(): Promise<RecentSessionsSnapshot> {
  const args = [
    'sessions',
    '--json',
    '--all-agents',
    '--active',
    String(RECENT_SESSIONS_ACTIVE_MINUTES),
    '--limit',
    String(DEFAULT_RECENT_SESSIONS_LIMIT),
  ];
  const stdout = await execOpenClaw(args);
  return buildRecentSessionsFromOpenClawJson(stdout, {
    limit: DEFAULT_RECENT_SESSIONS_LIMIT,
    resolveDisplayLabel: resolveOpenClawDisplayLabel,
  });
}

export async function buildRecentSessionsFromOpenClawJson(
  stdout: string,
  options: BuildRecentSessionsOptions = {},
): Promise<RecentSessionsSnapshot> {
  const parsed = parseOpenClawSessionsJson(stdout);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as OpenClawSessionsJson).sessions)
      ? (parsed as OpenClawSessionsJson).sessions!
      : [];

  return buildRecentSessionsFromRows(rows, options);
}

export async function buildRecentSessionsFromRows(
  rows: unknown[],
  options: BuildRecentSessionsOptions = {},
): Promise<RecentSessionsSnapshot> {
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_RECENT_SESSIONS_LIMIT, DEFAULT_RECENT_SESSIONS_LIMIT));
  const parsed = rows
    .filter((row) => !isSubagentSessionRow(row))
    .map(parseOpenClawSessionRow)
    .filter((session): session is RecentSession => !!session)
    .filter((session) => !isSubagentSession(session))
    .sort((a, b) => compareLastActivityDesc(a.lastActivity, b.lastActivity))
    .slice(0, limit);

  const sessions: RecentSession[] = [];
  for (const session of parsed) {
    const displayLabel = (await options.resolveDisplayLabel?.(session))?.trim() || session.displayLabel;
    sessions.push({ ...session, displayLabel });
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sessions,
  };
}

function parseOpenClawSessionsJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseOpenClawSessionRow(row: unknown): RecentSession | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const source = row as Record<string, unknown>;
  const sessionKey = readString(source.key) ?? readString(source.sessionKey);
  if (!sessionKey) return null;

  const parsedKey = parseOpenClawSessionKey(sessionKey);
  const sessionId = readString(source.sessionId) ?? readString(source.id) ?? sessionKey;
  const agent = readString(source.agentId) ?? parsedKey.agent;
  const lastActivity =
    readTimestamp(source.updatedAt) ?? readTimestamp(source.lastActivity) ?? readTimestamp(source.lastActivityAt);
  const channel = readString(source.channel) ?? parsedKey.channel;
  const target = readString(source.target) ?? parsedKey.target;
  const accountId = readString(source.accountId) ?? readString(source.account);

  return {
    sessionId,
    sessionKey,
    agent: agent || 'unknown',
    channel,
    target,
    ...(accountId ? { accountId } : {}),
    lastActivity,
    displayLabel: sessionKey,
  };
}

function isSubagentSessionRow(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const source = row as Record<string, unknown>;
  const kind = readString(source.kind);
  const channel = readString(source.channel);
  if (kind === 'subagent' || channel === 'subagent') return true;
  const sessionKey = readString(source.key) ?? readString(source.sessionKey);
  if (!sessionKey) return false;
  return hasSubagentSessionKey(sessionKey);
}

function isSubagentSession(session: RecentSession): boolean {
  if (session.channel === 'subagent') return true;
  return hasSubagentSessionKey(session.sessionKey);
}

function hasSubagentSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  return parts[0] === 'agent' && parts[2] === 'subagent';
}

export function parseOpenClawSessionKey(sessionKey: string): {
  agent?: string;
  channel?: string;
  target?: string;
} {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  if (parts[0] !== 'agent') return {};
  const agent = parts[1];
  const channel = parts[2];
  if (!channel) return { ...(agent ? { agent } : {}) };

  if (channel === 'discord') {
    const id = parts.at(-1);
    return {
      ...(agent ? { agent } : {}),
      channel,
      ...(id ? { target: `channel:${id}` } : {}),
    };
  }

  const kind = parts[3];
  const id = parts.at(-1);
  return {
    ...(agent ? { agent } : {}),
    channel,
    ...(kind && id && id !== kind ? { target: `${kind}:${id}` } : {}),
  };
}

async function resolveOpenClawDisplayLabel(session: RecentSession): Promise<string | undefined> {
  if (session.channel !== 'discord' || !session.target?.startsWith('channel:')) return undefined;
  return resolveDiscordChannelLabel(session.target);
}

export async function resolveDiscordChannelLabel(target: string): Promise<string | undefined> {
  const args = ['message', 'channel', 'info', '--channel', 'discord', '--target', target, '--json'];
  try {
    const stdout = await execOpenClaw(args);
    return extractDiscordChannelName(stdout);
  } catch {
    return undefined;
  }
}

export function extractDiscordChannelName(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const payloadThread = readPathString(parsed, ['payload', 'thread', 'name']);
  const thread = readPathString(parsed, ['thread', 'name']);
  const payloadChannel = readPathString(parsed, ['payload', 'channel', 'name']);
  const channel = readPathString(parsed, ['channel', 'name']);
  const name = readPathString(parsed, ['name']);
  return payloadThread ?? thread ?? payloadChannel ?? channel ?? name;
}

function readPathString(value: unknown, path: string[]): string | undefined {
  let cur = value;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return readString(cur);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readTimestamp(value: unknown): string | undefined {
  const text = readString(value);
  if (text) return text;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return undefined;
  return timestamp.toISOString();
}

function compareLastActivityDesc(a: string | undefined, b: string | undefined): number {
  const at = Date.parse(a ?? '');
  const bt = Date.parse(b ?? '');
  const av = Number.isFinite(at) ? at : 0;
  const bv = Number.isFinite(bt) ? bt : 0;
  return bv - av;
}

export const defaultRecentSessionsCache = createRecentSessionsCache({
  loadSessions: () => getRecentSessionsWithOpenClaw(),
  ttlMs: DEFAULT_RECENT_SESSIONS_TTL_MS,
});
