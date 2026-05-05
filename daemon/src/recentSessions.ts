import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_RECENT_SESSION_LIMIT = 10;
export const DEFAULT_RECENT_SESSION_POLL_MS = 60_000;
const DEFAULT_ACTIVE_MINUTES = 10_080;
const DISCORD_CHANNEL_INFO_TIMEOUT_MS = 2_500;
const ROUTABLE_MESSAGE_CHANNELS = new Set([
  'telegram', 'whatsapp', 'discord', 'irc', 'googlechat', 'slack', 'signal',
  'imessage', 'feishu', 'nostr', 'msteams', 'mattermost', 'nextcloud-talk',
  'matrix', 'bluebubbles', 'line', 'zalo', 'zalouser', 'synology-chat',
  'tlon', 'qa-channel', 'qqbot', 'twitch',
]);

export interface RecentSessionEntry {
  id: string;
  label: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  kind?: string;
  lastActivity?: string;
}

export interface RecentSessionsSnapshot {
  generatedAt: string;
  sessions: RecentSessionEntry[];
}

export interface RecentSessionsCacheOptions {
  limit?: number;
  pollMs?: number;
  activeMinutes?: number;
  autoStart?: boolean;
  loadSessions?: () => Promise<RecentSessionEntry[]>;
}

export class RecentSessionsCache {
  private readonly limit: number;
  private readonly pollMs: number;
  private readonly activeMinutes: number;
  private readonly loadSessionsOverride?: () => Promise<RecentSessionEntry[]>;
  private interval: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private snapshot: RecentSessionsSnapshot = {
    generatedAt: new Date(0).toISOString(),
    sessions: [],
  };

  constructor(opts: RecentSessionsCacheOptions = {}) {
    this.limit = opts.limit ?? DEFAULT_RECENT_SESSION_LIMIT;
    this.pollMs = opts.pollMs ?? DEFAULT_RECENT_SESSION_POLL_MS;
    this.activeMinutes = opts.activeMinutes ?? DEFAULT_ACTIVE_MINUTES;
    this.loadSessionsOverride = opts.loadSessions;
    if (opts.autoStart !== false) this.start();
  }

  start(): void {
    if (this.interval) return;
    void this.refresh();
    this.interval = setInterval(() => {
      void this.refresh();
    }, this.pollMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  getSnapshot(): RecentSessionsSnapshot {
    return {
      generatedAt: this.snapshot.generatedAt,
      sessions: this.snapshot.sessions.map((session) => ({ ...session })),
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const sessions = this.loadSessionsOverride
          ? await this.loadSessionsOverride()
          : await loadRecentOpenClawSessions({ limit: this.limit, activeMinutes: this.activeMinutes });
        this.snapshot = {
          generatedAt: new Date().toISOString(),
          sessions: sessions.slice(0, this.limit),
        };
      } catch (err) {
        console.error(`[sessions] recent session refresh failed: ${safeErrorMessage(err)}`);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }
}

export async function loadRecentOpenClawSessions(opts: {
  limit?: number;
  activeMinutes?: number;
} = {}): Promise<RecentSessionEntry[]> {
  const limit = opts.limit ?? DEFAULT_RECENT_SESSION_LIMIT;
  const activeMinutes = opts.activeMinutes ?? DEFAULT_ACTIVE_MINUTES;
  const stdout = await execOpenClaw([
    'sessions',
    '--json',
    '--all-agents',
    '--active',
    String(activeMinutes),
    '--limit',
    String(Math.max(limit * 3, limit)),
  ]);
  const rows = parseOpenClawSessions(stdout)
    .filter(isSelectableSessionRow)
    .sort(compareSessionRowsByLastActivityDesc);

  const entries: RecentSessionEntry[] = [];
  for (const row of rows) {
    const entry = await sessionRowToEntry(row);
    if (!entry) continue;
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

export interface OpenClawSessionRow {
  key?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  kind?: unknown;
  updatedAt?: unknown;
  lastActivity?: unknown;
  lastActivityAt?: unknown;
}

function parseOpenClawSessions(stdout: string): OpenClawSessionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];
  return rows.filter((row): row is OpenClawSessionRow => !!row && typeof row === 'object');
}

export async function sessionRowToEntry(
  row: OpenClawSessionRow,
  lookupChannelLabel: (target: string, accountId?: string) => Promise<string | undefined> = lookupDiscordChannelLabel,
): Promise<RecentSessionEntry | null> {
  const sessionId = readTrimmed(row.sessionId);
  const sessionKey = readTrimmed(row.key);
  if (!sessionId && !sessionKey) return null;

  const route = deriveRouteFromSessionKey(sessionKey);
  const discordLabel = route.channel === 'discord' && route.target
    ? await lookupChannelLabel(route.target, route.accountId)
    : undefined;
  const fallbackLabel = sessionKey || sessionId || 'OpenClaw session';
  const label = discordLabel || buildFallbackLabel({
    sessionKey,
    sessionId,
    agentId: readTrimmed(row.agentId),
    kind: readTrimmed(row.kind),
  });
  const lastActivity = readLastActivity(row);

  return {
    id: sessionId || sessionKey!,
    label: label || fallbackLabel,
    sessionId: sessionId || sessionKey!,
    ...(sessionKey ? { sessionKey } : {}),
    ...(readTrimmed(row.agentId) ? { agentId: readTrimmed(row.agentId) } : {}),
    ...(route.channel ? { channel: route.channel } : {}),
    ...(route.target ? { target: route.target } : {}),
    ...(route.accountId ? { accountId: route.accountId } : {}),
    ...(readTrimmed(row.kind) ? { kind: readTrimmed(row.kind) } : {}),
    ...(lastActivity ? { lastActivity } : {}),
  };
}

export function compareSessionRowsByLastActivityDesc(a: OpenClawSessionRow, b: OpenClawSessionRow): number {
  return readLastActivityMillis(b) - readLastActivityMillis(a);
}

function readLastActivity(row: OpenClawSessionRow): string | undefined {
  return readTimestamp(row.lastActivity)?.text
    ?? readTimestamp(row.lastActivityAt)?.text
    ?? readTimestamp(row.updatedAt)?.text;
}

function readLastActivityMillis(row: OpenClawSessionRow): number {
  return readTimestamp(row.lastActivity)?.millis
    ?? readTimestamp(row.lastActivityAt)?.millis
    ?? readTimestamp(row.updatedAt)?.millis
    ?? 0;
}

function readTimestamp(value: unknown): { text: string; millis: number } | undefined {
  if (typeof value === 'number') return readNumericTimestamp(value);

  const text = readTrimmed(value);
  if (!text) return undefined;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return readNumericTimestamp(numeric);

  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) return { text, millis: 0 };
  return { text, millis };
}

function readNumericTimestamp(value: number): { text: string; millis: number } | undefined {
  if (!Number.isFinite(value)) return undefined;
  const date = new Date(value);
  const millis = date.getTime();
  if (!Number.isFinite(millis)) return undefined;
  return { text: date.toISOString(), millis };
}

export function deriveRouteFromSessionKey(sessionKey: string | undefined): {
  channel?: string;
  target?: string;
  accountId?: string;
} {
  if (!sessionKey?.startsWith('agent:')) return {};
  const parts = sessionKey.split(':').map((part) => part.trim()).filter(Boolean);
  const channel = parts[2];
  if (!channel || !ROUTABLE_MESSAGE_CHANNELS.has(channel)) return {};

  const channelIndex = parts.indexOf('channel', 3);
  if (channelIndex >= 0 && parts[channelIndex + 1]) {
    return { channel, target: `channel:${parts[channelIndex + 1]}` };
  }

  const threadIndex = parts.indexOf('thread', 3);
  if (threadIndex >= 0 && parts[threadIndex + 1]) {
    return { channel, target: `channel:${parts[threadIndex + 1]}` };
  }

  if (parts[3] && !['direct', 'subagent', 'cron', 'main'].includes(parts[3])) {
    return { channel, target: `channel:${parts[3]}` };
  }

  return { channel };
}

function isSelectableSessionRow(row: OpenClawSessionRow): boolean {
  const kind = readTrimmed(row.kind);
  if (kind === 'cron') return false;
  const key = readTrimmed(row.key);
  if (!key) return !!readTrimmed(row.sessionId);
  const route = deriveRouteFromSessionKey(key);
  return !!route.channel;
}

async function lookupDiscordChannelLabel(target: string, accountId?: string): Promise<string | undefined> {
  try {
    const args = [
      'message', 'channel', 'info',
      '--channel', 'discord',
      '--target', target,
      '--json',
      ...(accountId ? ['--account', accountId] : []),
    ];
    const stdout = await execOpenClaw(args, { timeout: DISCORD_CHANNEL_INFO_TIMEOUT_MS });
    return parseDiscordChannelLabel(stdout);
  } catch {
    return undefined;
  }
}

export function parseDiscordChannelLabel(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const payload = parsed && typeof parsed === 'object'
    ? (parsed as { payload?: unknown }).payload
    : undefined;
  const channel = payload && typeof payload === 'object'
    ? (payload as { channel?: unknown }).channel
    : undefined;
  if (!channel || typeof channel !== 'object') return undefined;
  const name = readTrimmed((channel as { name?: unknown }).name);
  return name;
}

function buildFallbackLabel(input: {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  kind?: string;
}): string {
  const key = input.sessionKey;
  if (key?.startsWith('agent:')) {
    const parts = key.split(':').map((part) => part.trim()).filter(Boolean);
    const agent = parts[1] || input.agentId || 'agent';
    const channel = parts[2];
    const id = parts.at(-1);
    if (channel && id && id !== channel) return `${agent} · ${channel} · ${id}`;
    if (channel) return `${agent} · ${channel}`;
  }
  return key || input.sessionId || 'OpenClaw session';
}

async function execOpenClaw(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync('openclaw', args, {
    timeout: opts.timeout ?? 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function readTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
