import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RecentSession, RecentSessionsSnapshot } from './protocol.js';

export const DEFAULT_RECENT_SESSIONS_TTL_MS = 60_000;
export const DEFAULT_RECENT_SESSIONS_LIMIT = 10;
const RECENT_SESSIONS_ACTIVE_MINUTES = 10_080;
const RECENT_SESSIONS_FETCH_MULTIPLIER = 3;
const RECENT_SESSION_PREVIEW_TIMEOUT_MS = 5_000;
const RECENT_SESSION_PREVIEW_MAX_CHARS = 220;
const SESSION_KEY_PREFIX = 'agent:';

export interface RecentSessionsCacheOptions {
  loadSessions: () => Promise<RecentSessionsSnapshot>;
  ttlMs: number;
  now?: () => number;
  refreshOnCreate?: boolean;
}

export interface RecentSessionsCache {
  get(): Promise<RecentSessionsSnapshot>;
  refresh(): Promise<RecentSessionsSnapshot>;
}

export type RecentSessionPreviewFields = Pick<
  RecentSession,
  'lastMessagePreview' | 'lastMessageRole' | 'lastAssistantPreview'
>;

export type RecentSessionPreviewMap = Map<string, RecentSessionPreviewFields>;

export interface BuildRecentSessionsOptions {
  limit?: number;
  generatedAt?: string;
  resolveDisplayLabel?: (session: RecentSession) => Promise<string | undefined>;
  resolveSessionPreviews?: (sessions: RecentSession[]) => Promise<RecentSessionPreviewMap | undefined>;
  resolveSessionAccountId?: (session: RecentSession) => Promise<string | undefined> | string | undefined;
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
  let refreshPromise: Promise<RecentSessionsSnapshot> | undefined;
  const now = options.now ?? Date.now;

  const refresh = (): Promise<RecentSessionsSnapshot> => {
    if (refreshPromise) return refreshPromise;
    const startedAt = now();
    refreshPromise = (async () => {
      try {
        cached = await options.loadSessions();
      } catch {
        cached ??= createEmptyRecentSessionsSnapshot(new Date(startedAt).toISOString());
      }
      expiresAt = now() + options.ttlMs;
      return cached;
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };

  if (options.refreshOnCreate) void refresh();

  return {
    async get(): Promise<RecentSessionsSnapshot> {
      const ts = now();
      if (cached && ts < expiresAt && !refreshPromise) return cached;
      return refresh();
    },
    refresh,
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
    String(DEFAULT_RECENT_SESSIONS_LIMIT * RECENT_SESSIONS_FETCH_MULTIPLIER),
  ];
  const stdout = await execOpenClaw(args);
  return buildRecentSessionsFromOpenClawJson(stdout, {
    limit: DEFAULT_RECENT_SESSIONS_LIMIT,
    resolveSessionAccountId: resolveOpenClawSessionAccountId,
    resolveDisplayLabel: resolveOpenClawDisplayLabel,
    resolveSessionPreviews: resolveOpenClawSessionPreviews,
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
    .filter((row) => !isCronSessionRow(row))
    .map(parseOpenClawSessionRow)
    .filter((session): session is RecentSession => !!session)
    .filter((session) => !isSubagentSession(session))
    .filter((session) => !isCronSession(session))
    .sort((a, b) => compareLastActivityDesc(a.lastActivity, b.lastActivity))
    .slice(0, limit);

  const routedSessions = await enrichRecentSessionsWithAccountIds(parsed, options.resolveSessionAccountId);

  const labeledSessions = await Promise.all(
    routedSessions.map(async (session) => {
      const displayLabel = (await options.resolveDisplayLabel?.(session))?.trim() || session.displayLabel;
      return { ...session, displayLabel };
    }),
  );
  const sessions = await enrichRecentSessionsWithPreviews(labeledSessions, options.resolveSessionPreviews);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sessions,
  };
}

async function enrichRecentSessionsWithAccountIds(
  sessions: RecentSession[],
  resolveSessionAccountId?: (session: RecentSession) => Promise<string | undefined> | string | undefined,
): Promise<RecentSession[]> {
  if (!resolveSessionAccountId || sessions.length === 0) return sessions;
  return Promise.all(
    sessions.map(async (session) => {
      if (session.accountId) return session;
      try {
        const accountId = (await resolveSessionAccountId(session))?.trim();
        return accountId ? { ...session, accountId } : session;
      } catch {
        return session;
      }
    }),
  );
}

async function enrichRecentSessionsWithPreviews(
  sessions: RecentSession[],
  resolveSessionPreviews?: (sessions: RecentSession[]) => Promise<RecentSessionPreviewMap | undefined>,
): Promise<RecentSession[]> {
  if (!resolveSessionPreviews || sessions.length === 0) return sessions;
  let previews: RecentSessionPreviewMap | undefined;
  try {
    previews = await resolveSessionPreviews(sessions);
  } catch {
    return sessions;
  }
  if (!previews || previews.size === 0) return sessions;
  return sessions.map((session) => {
    const preview = previews.get(session.sessionKey) ?? previews.get(session.sessionId);
    return preview ? { ...session, ...preview } : session;
  });
}

async function resolveOpenClawSessionPreviews(sessions: RecentSession[]): Promise<RecentSessionPreviewMap> {
  const keys = [...new Set(sessions.map((session) => session.sessionKey).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const stdout = await execOpenClaw([
    'gateway',
    'call',
    'sessions.preview',
    '--json',
    '--timeout',
    String(RECENT_SESSION_PREVIEW_TIMEOUT_MS),
    '--params',
    JSON.stringify({ keys }),
  ]);
  return extractOpenClawSessionPreviews(stdout);
}

export function extractOpenClawSessionPreviews(stdout: string): RecentSessionPreviewMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return new Map();
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { previews?: unknown[] }).previews)
      ? (parsed as { previews: unknown[] }).previews
      : [];

  const previews: RecentSessionPreviewMap = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const key = readString(source.key) ?? readString(source.sessionKey) ?? readString(source.sessionId) ?? readString(source.id);
    const items = Array.isArray(source.items) ? source.items : Array.isArray(source.messages) ? source.messages : [];
    const fields = buildRecentSessionPreviewFields(items);
    if (key && fields) previews.set(key, fields);
  }
  return previews;
}

function buildRecentSessionPreviewFields(items: unknown[]): RecentSessionPreviewFields | undefined {
  const normalized = items
    .map(normalizePreviewItem)
    .filter((item): item is { role?: string; text: string } => !!item?.text);
  if (normalized.length === 0) return undefined;

  const latestMessage = findLast(normalized, (item) => isMessagePreviewRole(item.role) || !item.role);
  const latestAssistant = findLast(normalized, (item) => item.role === 'assistant' || item.role === 'agent');
  const fields: RecentSessionPreviewFields = {};
  if (latestMessage) {
    fields.lastMessagePreview = latestMessage.text;
    if (latestMessage.role) fields.lastMessageRole = latestMessage.role === 'agent' ? 'assistant' : latestMessage.role;
  }
  if (latestAssistant) fields.lastAssistantPreview = latestAssistant.text;
  return fields.lastMessagePreview || fields.lastAssistantPreview ? fields : undefined;
}

function normalizePreviewItem(item: unknown): { role?: string; text: string } | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const source = item as Record<string, unknown>;
  const text = normalizePreviewText(
    readString(source.text) ?? readString(source.preview) ?? readString(source.content) ?? readString(source.message),
  );
  if (!text) return undefined;
  const role = readString(source.role)?.toLowerCase();
  return { ...(role ? { role } : {}), text };
}

function normalizePreviewText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= RECENT_SESSION_PREVIEW_MAX_CHARS) return normalized;
  return `${normalized.slice(0, RECENT_SESSION_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function isMessagePreviewRole(role: string | undefined): boolean {
  return role === 'assistant' || role === 'agent' || role === 'user';
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}

export async function resolveOpenClawSessionAccountId(
  session: Pick<RecentSession, 'sessionId' | 'sessionKey'>,
): Promise<string | undefined> {
  const sessionKey = session.sessionKey.trim();
  if (!sessionKey.startsWith(SESSION_KEY_PREFIX)) return undefined;

  try {
    const record = await readOpenClawSessionRecord(sessionKey, session.sessionId);
    return readSessionAccountId(record);
  } catch {
    return undefined;
  }
}

async function readOpenClawSessionRecord(sessionKey: string, sessionId?: string): Promise<unknown> {
  const agent = sessionKey.split(':')[1]?.trim();
  if (!agent) return undefined;

  const sessionsPath = join(getOpenClawStateDir(), 'agents', agent, 'sessions', 'sessions.json');
  let raw: string;
  try {
    raw = await readFile(sessionsPath, 'utf8');
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return findSessionRecord(parsed, sessionKey, sessionId);
}

export function getOpenClawConfigPath(): string {
  const configPath = normalizeEnvValue(process.env.OPENCLAW_CONFIG_PATH);
  if (configPath) return resolveUserPath(configPath);
  return join(getOpenClawStateDir(), 'openclaw.json');
}

function getOpenClawStateDir(): string {
  const stateDir = normalizeEnvValue(process.env.OPENCLAW_STATE_DIR);
  if (stateDir) return resolveUserPath(stateDir);

  const configPath = normalizeEnvValue(process.env.OPENCLAW_CONFIG_PATH);
  if (configPath) return dirname(resolveUserPath(configPath));

  return join(getRequiredOpenClawHomeDir(), '.openclaw');
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    return resolve(trimmed.replace(/^~(?=$|[\\/])/, getRequiredOpenClawHomeDir()));
  }
  return resolve(trimmed);
}

function getRequiredOpenClawHomeDir(): string {
  return getEffectiveOpenClawHomeDir() ?? resolve(process.cwd());
}

function getEffectiveOpenClawHomeDir(): string | undefined {
  const explicitHome = normalizeEnvValue(process.env.OPENCLAW_HOME);
  if (explicitHome) {
    if (explicitHome === '~' || explicitHome.startsWith('~/') || explicitHome.startsWith('~\\')) {
      const osHome = getEffectiveOsHomeDir();
      return osHome ? resolve(explicitHome.replace(/^~(?=$|[\\/])/, osHome)) : undefined;
    }
    return resolve(explicitHome);
  }
  return getEffectiveOsHomeDir();
}

function getEffectiveOsHomeDir(): string | undefined {
  const home = normalizeEnvValue(process.env.HOME) ?? normalizeEnvValue(process.env.USERPROFILE) ?? normalizeEnvValue(homedir());
  return home ? resolve(home) : undefined;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

function findSessionRecord(store: unknown, sessionKey: string, sessionId?: string): unknown {
  if (!store || typeof store !== 'object') return undefined;
  const requestedSessionId = sessionId?.trim();
  const matches = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const source = entry as Record<string, unknown>;
    if (readString(source.key) === sessionKey || readString(source.sessionKey) === sessionKey) return true;
    if (!requestedSessionId) return false;
    return readString(source.sessionId) === requestedSessionId || readString(source.id) === requestedSessionId;
  };

  if (Array.isArray(store)) return store.find(matches);

  const direct = (store as Record<string, unknown>)[sessionKey];
  if (direct) return direct;
  return Object.values(store as Record<string, unknown>).find(matches);
}

function readSessionAccountId(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const source = record as Record<string, unknown>;
  const origin = readObject(source.origin);
  const deliveryContext = readObject(source.deliveryContext);
  return (
    readString(source.accountId)
    ?? readString(source.account)
    ?? readString(source.lastAccountId)
    ?? readString(source.lastAccount)
    ?? readString(origin?.accountId)
    ?? readString(origin?.account)
    ?? readString(origin?.lastAccountId)
    ?? readString(origin?.lastAccount)
    ?? readString(deliveryContext?.accountId)
    ?? readString(deliveryContext?.account)
    ?? readString(deliveryContext?.lastAccountId)
    ?? readString(deliveryContext?.lastAccount)
  );
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT');
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
  const accountId = readString(source.accountId)
    ?? readString(source.account)
    ?? readString(source.lastAccountId)
    ?? readString(source.lastAccount);

  return {
    sessionId,
    sessionKey,
    agent: agent || 'unknown',
    channel,
    target,
    ...(accountId ? { accountId } : {}),
    lastActivity,
    displayLabel: buildFallbackDisplayLabel(sessionKey),
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

function isCronSessionRow(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const source = row as Record<string, unknown>;
  const kind = readString(source.kind)?.toLowerCase();
  const channel = readString(source.channel)?.toLowerCase();
  if (kind === 'cron' || channel === 'cron') return true;
  const sessionKey = readString(source.key) ?? readString(source.sessionKey);
  if (!sessionKey) return false;
  return hasCronSessionKey(sessionKey);
}

function isCronSession(session: RecentSession): boolean {
  if (session.channel === 'cron') return true;
  return hasCronSessionKey(session.sessionKey);
}

function hasSubagentSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  return parts[0] === 'agent' && parts[2] === 'subagent';
}

function hasCronSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  return parts[0] === 'agent' && parts[2] === 'cron';
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
    const kind = parts[3];
    const id = parts.at(-1);
    const targetKind = kind === 'direct' ? 'user' : kind === 'channel' ? 'channel' : kind;
    return {
      ...(agent ? { agent } : {}),
      channel,
      ...(targetKind && id && id !== kind ? { target: `${targetKind}:${id}` } : {}),
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
  if (!session.channel || !session.target) return undefined;
  if (session.channel === 'discord' && session.target.startsWith('user:')) {
    return resolveDiscordDirectLabel(session.target);
  }
  return resolveOpenClawChannelLabel(session.channel, session.target);
}

export async function resolveDiscordChannelLabel(target: string): Promise<string | undefined> {
  return resolveOpenClawChannelLabel('discord', target);
}

export async function resolveDiscordDirectLabel(target: string): Promise<string | undefined> {
  const userId = target.startsWith('user:') ? target.slice('user:'.length).trim() : '';
  if (!userId) return undefined;
  const name = await resolveDiscordMemberLabel(userId);
  return name ? `DM ${name}` : undefined;
}

async function resolveDiscordMemberLabel(userId: string): Promise<string | undefined> {
  // Use OpenClaw's message member info lookup for Discord DMs; if a guild is required, fall back silently.
  const args = ['message', 'member', 'info', '--channel', 'discord', '--user-id', userId, '--json'];
  try {
    const stdout = await execOpenClaw(args);
    return extractDiscordMemberName(stdout);
  } catch {
    return undefined;
  }
}

export async function resolveOpenClawChannelLabel(channel: string, target: string): Promise<string | undefined> {
  const args = ['message', 'channel', 'info', '--channel', channel, '--target', target, '--json'];
  try {
    const stdout = await execOpenClaw(args);
    return extractOpenClawChannelName(stdout);
  } catch {
    return undefined;
  }
}

export function extractOpenClawChannelName(stdout: string): string | undefined {
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

export function extractDiscordChannelName(stdout: string): string | undefined {
  return extractOpenClawChannelName(stdout);
}

export function extractDiscordMemberName(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const username =
    readPathString(parsed, ['payload', 'user', 'username']) ??
    readPathString(parsed, ['payload', 'member', 'user', 'username']) ??
    readPathString(parsed, ['user', 'username']) ??
    readPathString(parsed, ['member', 'user', 'username']) ??
    readPathString(parsed, ['payload', 'username']) ??
    readPathString(parsed, ['username']);
  if (username) return username;

  const globalName =
    readPathString(parsed, ['payload', 'user', 'global_name']) ??
    readPathString(parsed, ['payload', 'member', 'user', 'global_name']) ??
    readPathString(parsed, ['user', 'global_name']) ??
    readPathString(parsed, ['member', 'user', 'global_name']) ??
    readPathString(parsed, ['payload', 'global_name']) ??
    readPathString(parsed, ['global_name']);
  if (globalName) return globalName;

  return (
    readPathString(parsed, ['payload', 'member', 'nick']) ??
    readPathString(parsed, ['member', 'nick']) ??
    readPathString(parsed, ['payload', 'nick']) ??
    readPathString(parsed, ['nick'])
  );
}

export function buildFallbackDisplayLabel(sessionKey: string): string {
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  const visibleParts = parts[0] === 'agent' ? parts.slice(2) : parts;
  if (visibleParts.length === 0) return sessionKey;

  const [channel, kind, ...rest] = visibleParts;
  const id = rest.at(-1);
  if (channel === 'discord' && kind === 'direct' && id) return `DM ${id}`;
  if (kind && id && id !== kind) return `${kind} ${id}`;
  return visibleParts.join(' ');
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
