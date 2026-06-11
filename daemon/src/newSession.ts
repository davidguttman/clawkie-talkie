// New-session destination catalog + creation for the host dashboard.
//
// The daemon is the trusted side: the browser never holds OpenClaw,
// Discord, or Slack credentials, so it asks the daemon which chat
// surfaces a brand-new OpenClaw session could be bound to and then asks
// the daemon to create one. Three creation paths exist:
//
//   - Local web/no-chat sessions: the daemon mints a fresh OpenClaw
//     sessionId and the session materializes on the first
//     `openclaw agent --session-id <id>` voice turn — no extra OpenClaw
//     CLI surface and no credentials are involved at create time.
//   - Discord: the daemon creates a real thread through
//     `openclaw message thread create --channel discord` against a
//     destination picked from the real channel catalog
//     (`openclaw message channel list --channel discord --json`, see
//     discordChannels.ts), then returns a session bound to the new
//     thread so the voice flow delivers transcript + reply there.
//   - Slack: Slack threads hang off a parent-channel message, so the
//     daemon posts a starter message through
//     `openclaw message send --channel slack --json` against a
//     destination from the real Slack channel catalog
//     (slackChannels.ts), reads the Slack message ts back as the thread
//     id, and returns a session keyed
//     `agent:<agent>:slack:channel:<C>:thread:<ts>` — the same Slack
//     thread session-key shape OpenClaw itself uses — so the voice flow
//     delivers transcript + reply into that thread (see chatSession.ts).
//
// Destinations are always real parent channels from the provider
// catalogs — never recent session rows, which are threads/DMs/stale
// targets and read as an incoherent channel list. A provider with no
// real creatable channels is omitted from the catalog entirely instead
// of being shown as a disabled/unsupported placeholder or backed by
// fake channels.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  daemonToPhone,
  type DaemonToPhone,
  type NewSessionDestinationOption,
  type NewSessionDestinationProvider,
  type NewSessionDestinationsCatalog,
  type RecentSession,
} from './protocol.js';
import { listDiscordChannelDestinations } from './discordChannels.js';
import { listSlackChannelDestinations } from './slackChannels.js';
import { parseJsonCandidates, type OpenClawExec } from './channelCatalog.js';
import { generateUuid } from './uuid.js';

export type { OpenClawExec } from './channelCatalog.js';

const execFileAsync = promisify(execFile);

export const WEBCHAT_DESTINATION_PROVIDER_ID = 'webchat';
export const DISCORD_DESTINATION_PROVIDER_ID = 'discord';
export const SLACK_DESTINATION_PROVIDER_ID = 'slack';
export const DEFAULT_NEW_SESSION_AGENT = 'main';
export const DISCORD_THREAD_CREATE_FAILED = 'discord_thread_create_failed';
export const DISCORD_THREAD_ID_UNRESOLVED = 'discord_thread_id_unresolved';
export const SLACK_THREAD_CREATE_FAILED = 'slack_thread_create_failed';
export const SLACK_THREAD_TS_UNRESOLVED = 'slack_thread_ts_unresolved';
export const NEW_SESSION_THREAD_STARTER_MESSAGE = 'Starting a Clawkie Talkie voice session.';

const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
// Destinations look like `channel:<id>` or `user:<id>`; keep the
// charset tight since the value is forwarded to the OpenClaw CLI.
const SAFE_DESTINATION_TARGET = /^[A-Za-z0-9:._@-]+$/;
const SAFE_THREAD_ID = /^[A-Za-z0-9_-]+$/;
// Slack message/thread timestamps look like `1710000000.000100`.
const SLACK_THREAD_TS = /^\d+\.\d+$/;
const SLACK_CHANNEL_TARGET = /^channel:([A-Za-z0-9_-]+)$/;

const CHANNEL_PROVIDER_LABELS: Record<string, string> = {
  discord: 'Discord',
  slack: 'Slack',
};

function webchatDestinationProvider(): NewSessionDestinationProvider {
  return {
    id: WEBCHAT_DESTINATION_PROVIDER_ID,
    label: 'Web only (no chat channel)',
    kind: 'local',
    status: 'available',
    destinations: [],
  };
}

export function createWebchatOnlyNewSessionDestinationsCatalog(
  generatedAt = new Date().toISOString(),
): NewSessionDestinationsCatalog {
  return { generatedAt, providers: [webchatDestinationProvider()] };
}

// A channel provider is offered only when real channel destinations
// were discovered; an empty catalog yields no provider at all — the
// dashboard simply does not show that chat choice.
export function buildChannelNewSessionDestinationProvider(
  providerId: string,
  destinations: NewSessionDestinationOption[],
): NewSessionDestinationProvider | undefined {
  if (destinations.length === 0) return undefined;
  return {
    id: providerId,
    label: CHANNEL_PROVIDER_LABELS[providerId]
      ?? providerId.charAt(0).toUpperCase() + providerId.slice(1),
    kind: 'channel',
    status: 'available',
    destinations,
  };
}

export interface GetNewSessionDestinationsOptions {
  loadDiscordDestinations?: () => Promise<NewSessionDestinationOption[]>;
  loadSlackDestinations?: () => Promise<NewSessionDestinationOption[]>;
}

export async function getNewSessionDestinationsWithOpenClaw(
  options: GetNewSessionDestinationsOptions = {},
): Promise<NewSessionDestinationsCatalog> {
  const loadDiscordDestinations = options.loadDiscordDestinations ?? listDiscordChannelDestinations;
  const loadSlackDestinations = options.loadSlackDestinations ?? listSlackChannelDestinations;
  const generatedAt = new Date().toISOString();

  // Catalog discovery being down never blocks local web sessions and
  // never degrades a provider into recent-session rows — a provider
  // whose catalog fails or comes back empty is omitted.
  const [discordResult, slackResult] = await Promise.allSettled([
    loadDiscordDestinations(),
    loadSlackDestinations(),
  ]);

  const providers: NewSessionDestinationProvider[] = [webchatDestinationProvider()];
  const discordProvider = buildChannelNewSessionDestinationProvider(
    DISCORD_DESTINATION_PROVIDER_ID,
    discordResult.status === 'fulfilled' ? discordResult.value : [],
  );
  if (discordProvider) providers.push(discordProvider);
  const slackProvider = buildChannelNewSessionDestinationProvider(
    SLACK_DESTINATION_PROVIDER_ID,
    slackResult.status === 'fulfilled' ? slackResult.value : [],
  );
  if (slackProvider) providers.push(slackProvider);

  return { generatedAt, providers };
}

export interface NewSessionCreateRequestLike {
  requestId?: unknown;
  providerId?: unknown;
  agent?: unknown;
  target?: unknown;
  accountId?: unknown;
}

export type NewSessionCreateValidation =
  | { ok: true; providerId: typeof WEBCHAT_DESTINATION_PROVIDER_ID; agent: string }
  | {
      ok: true;
      providerId: typeof DISCORD_DESTINATION_PROVIDER_ID | typeof SLACK_DESTINATION_PROVIDER_ID;
      agent: string;
      target: string;
      accountId?: string;
    }
  | { ok: false; message: string };

export function validateNewSessionCreateRequest(
  msg: NewSessionCreateRequestLike,
): NewSessionCreateValidation {
  if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
    return { ok: false, message: 'invalid_new_session_request' };
  }
  const providerId = typeof msg.providerId === 'string' ? msg.providerId.trim() : '';
  if (
    providerId !== WEBCHAT_DESTINATION_PROVIDER_ID
    && providerId !== DISCORD_DESTINATION_PROVIDER_ID
    && providerId !== SLACK_DESTINATION_PROVIDER_ID
  ) {
    return { ok: false, message: 'new_session_destination_unsupported' };
  }
  const agent = typeof msg.agent === 'string' && msg.agent.trim() ? msg.agent.trim() : DEFAULT_NEW_SESSION_AGENT;
  if (!SAFE_AGENT_ID.test(agent)) {
    return { ok: false, message: 'invalid_new_session_agent' };
  }
  if (providerId === DISCORD_DESTINATION_PROVIDER_ID || providerId === SLACK_DESTINATION_PROVIDER_ID) {
    const target = typeof msg.target === 'string' ? msg.target.trim() : '';
    if (!target || !SAFE_DESTINATION_TARGET.test(target)) {
      return { ok: false, message: 'invalid_new_session_target' };
    }
    if (providerId === SLACK_DESTINATION_PROVIDER_ID && !SLACK_CHANNEL_TARGET.test(target)) {
      return { ok: false, message: 'invalid_new_session_target' };
    }
    const accountId = typeof msg.accountId === 'string' && msg.accountId.trim() ? msg.accountId.trim() : undefined;
    if (accountId && !SAFE_DESTINATION_TARGET.test(accountId)) {
      return { ok: false, message: 'invalid_new_session_account' };
    }
    return {
      ok: true,
      providerId,
      agent,
      target,
      ...(accountId ? { accountId } : {}),
    };
  }
  return { ok: true, providerId: WEBCHAT_DESTINATION_PROVIDER_ID, agent };
}

export interface CreateWebchatNewSessionOptions {
  agent: string;
  generateSessionId?: () => string;
  now?: () => Date;
}

export function createWebchatNewSession(options: CreateWebchatNewSessionOptions): RecentSession {
  const sessionId = (options.generateSessionId ?? generateUuid)();
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    sessionId,
    // Webchat-shaped OpenClaw session key. The voice flow only uses it
    // to select the agent and to mark the session as non-delivered;
    // the session identity passed to `openclaw agent --session-id` is
    // the minted UUID, which OpenClaw materializes on the first turn.
    sessionKey: `agent:${options.agent}:webchat:session:${sessionId}`,
    agent: options.agent,
    channel: WEBCHAT_DESTINATION_PROVIDER_ID,
    lastActivity: createdAt,
    displayLabel: 'New web session',
  };
}

export class NewSessionCreateError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'NewSessionCreateError';
  }
}

export function defaultNewSessionThreadName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Voice session — ${date} ${time}`;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && SAFE_THREAD_ID.test(trimmed) ? trimmed : undefined;
}

function findThreadId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findThreadId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (/^thread[_-]?id$/i.test(key)) {
      const id = normalizeThreadId(entry);
      if (id) return id;
    }
  }
  const thread = record.thread;
  if (thread && typeof thread === 'object' && !Array.isArray(thread)) {
    const id = normalizeThreadId((thread as Record<string, unknown>).id);
    if (id) return id;
  }
  for (const entry of Object.values(record)) {
    const found = findThreadId(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// Output shapes vary across OpenClaw versions: a bare `{threadId}`, a
// `{thread: {id}}` object, or either nested under `data`/`result`/
// `payload`. Search the parsed JSON instead of pinning one shape.
export function extractDiscordThreadIdFromOutput(stdout: string): string | undefined {
  for (const candidate of parseJsonCandidates(stdout)) {
    const found = findThreadId(candidate);
    if (found) return found;
  }
  return undefined;
}

function normalizeSlackTs(value: unknown): string | undefined {
  // Slack timestamps must stay strings: a JSON number like
  // 1710000000.000100 silently loses its trailing zeros and would
  // corrupt the thread id, so numeric ts values are rejected.
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && SLACK_THREAD_TS.test(trimmed) ? trimmed : undefined;
}

function findSlackThreadTs(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSlackThreadTs(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // An explicit thread ts wins over the message's own ts at this level.
  for (const [key, entry] of Object.entries(record)) {
    if (/^thread[_-]?ts$/i.test(key)) {
      const ts = normalizeSlackTs(entry);
      if (ts) return ts;
    }
  }
  for (const [key, entry] of Object.entries(record)) {
    if (/^(?:message[_-]?)?ts$/i.test(key) || /^(?:message[_-]?|thread[_-]?)?id$/i.test(key)) {
      const ts = normalizeSlackTs(entry);
      if (ts) return ts;
    }
  }
  for (const entry of Object.values(record)) {
    const found = findSlackThreadTs(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// `openclaw message send --json` output shapes vary the same way the
// thread-create output does; additionally the Slack message timestamp
// may surface as `ts`, `messageTs`/`message_ts`, `threadTs`/
// `thread_ts`, or a ts-shaped `messageId`. Only ts-shaped string values
// are accepted — anything else cannot address a Slack thread.
export function extractSlackThreadTsFromOutput(stdout: string): string | undefined {
  for (const candidate of parseJsonCandidates(stdout)) {
    const found = findSlackThreadTs(candidate);
    if (found) return found;
  }
  return undefined;
}

export interface CreateDiscordNewSessionOptions {
  agent: string;
  target: string;
  accountId?: string;
  threadName?: string;
  generateSessionId?: () => string;
  now?: () => Date;
  execOpenClaw?: OpenClawExec;
}

export async function createDiscordNewSession(
  options: CreateDiscordNewSessionOptions,
): Promise<RecentSession> {
  const now = (options.now ?? (() => new Date()))();
  const threadName = options.threadName?.trim() || defaultNewSessionThreadName(now);
  const exec = options.execOpenClaw ?? ((command, args) => execFileAsync(command, args));
  const args = [
    'message', 'thread', 'create',
    '--channel', 'discord',
    '--target', options.target,
    '--thread-name', threadName,
    '--message', NEW_SESSION_THREAD_STARTER_MESSAGE,
    '--json',
    ...(options.accountId ? ['--account', options.accountId] : []),
  ];
  let stdout: string;
  try {
    ({ stdout } = await exec('openclaw', args));
  } catch {
    throw new NewSessionCreateError(DISCORD_THREAD_CREATE_FAILED);
  }
  const threadId = extractDiscordThreadIdFromOutput(stdout);
  if (!threadId) {
    throw new NewSessionCreateError(DISCORD_THREAD_ID_UNRESOLVED);
  }
  const sessionId = (options.generateSessionId ?? generateUuid)();
  return {
    sessionId,
    // Discord-shaped OpenClaw session key bound to the new thread. The
    // voice flow's explicit delivery path posts transcript + reply to
    // `channel:<threadId>`; the OpenClaw session itself materializes on
    // the first `openclaw agent --session-id <uuid>` turn.
    sessionKey: `agent:${options.agent}:discord:channel:${threadId}`,
    agent: options.agent,
    channel: DISCORD_DESTINATION_PROVIDER_ID,
    target: `channel:${threadId}`,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    lastActivity: now.toISOString(),
    displayLabel: threadName,
  };
}

export interface CreateSlackNewSessionOptions {
  agent: string;
  target: string;
  accountId?: string;
  threadName?: string;
  generateSessionId?: () => string;
  now?: () => Date;
  execOpenClaw?: OpenClawExec;
}

// Slack has no free-standing thread object: a thread is anchored to a
// parent-channel message and addressed by that message's ts. Creating a
// "new Slack session" therefore posts a starter message to the picked
// parent channel and binds the session to the starter's ts as the
// thread id.
export async function createSlackNewSession(
  options: CreateSlackNewSessionOptions,
): Promise<RecentSession> {
  const channelMatch = SLACK_CHANNEL_TARGET.exec(options.target.trim());
  if (!channelMatch) {
    throw new NewSessionCreateError('invalid_new_session_target');
  }
  const channelId = channelMatch[1];
  const now = (options.now ?? (() => new Date()))();
  const threadName = options.threadName?.trim() || defaultNewSessionThreadName(now);
  const exec = options.execOpenClaw ?? ((command, args) => execFileAsync(command, args));
  const args = [
    'message', 'send',
    '--channel', 'slack',
    '--target', `channel:${channelId}`,
    '--message', `${threadName} — ${NEW_SESSION_THREAD_STARTER_MESSAGE}`,
    '--json',
    ...(options.accountId ? ['--account', options.accountId] : []),
  ];
  let stdout: string;
  try {
    ({ stdout } = await exec('openclaw', args));
  } catch {
    throw new NewSessionCreateError(SLACK_THREAD_CREATE_FAILED);
  }
  const threadTs = extractSlackThreadTsFromOutput(stdout);
  if (!threadTs) {
    throw new NewSessionCreateError(SLACK_THREAD_TS_UNRESOLVED);
  }
  const sessionId = (options.generateSessionId ?? generateUuid)();
  return {
    sessionId,
    // Slack-thread-shaped OpenClaw session key (the same shape OpenClaw
    // uses for Slack thread sessions). chatSession.ts derives the
    // thread route from this key: transcript + reply are posted to the
    // parent channel with the thread ts so they land in the thread.
    sessionKey: `agent:${options.agent}:slack:channel:${channelId}:thread:${threadTs}`,
    agent: options.agent,
    channel: SLACK_DESTINATION_PROVIDER_ID,
    target: `channel:${channelId}`,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    lastActivity: now.toISOString(),
    displayLabel: threadName,
  };
}

export function readNewSessionCreateRequestId(msg: NewSessionCreateRequestLike): string {
  return typeof msg.requestId === 'string' ? msg.requestId : '';
}

export interface BuildNewSessionCreateResponseOptions {
  generateSessionId?: () => string;
  now?: () => Date;
  execOpenClaw?: OpenClawExec;
}

export async function buildNewSessionCreateResponse(
  msg: NewSessionCreateRequestLike,
  options: BuildNewSessionCreateResponseOptions = {},
): Promise<DaemonToPhone> {
  const requestId = readNewSessionCreateRequestId(msg);
  const validation = validateNewSessionCreateRequest(msg);
  if (!validation.ok) {
    return daemonToPhone.sessionsCreateError(requestId, validation.message);
  }
  try {
    const session = validation.providerId === DISCORD_DESTINATION_PROVIDER_ID
      ? await createDiscordNewSession({
          ...options,
          agent: validation.agent,
          target: validation.target,
          ...(validation.accountId ? { accountId: validation.accountId } : {}),
        })
      : validation.providerId === SLACK_DESTINATION_PROVIDER_ID
        ? await createSlackNewSession({
            ...options,
            agent: validation.agent,
            target: validation.target,
            ...(validation.accountId ? { accountId: validation.accountId } : {}),
          })
        : createWebchatNewSession({ ...options, agent: validation.agent });
    return daemonToPhone.sessionsCreated(requestId, session);
  } catch (err) {
    const code = err instanceof NewSessionCreateError ? err.code : 'new_session_create_failed';
    return daemonToPhone.sessionsCreateError(requestId, code);
  }
}
