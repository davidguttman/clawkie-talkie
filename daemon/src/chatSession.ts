// OpenClaw-integrated chat completions — uses OpenClaw CLI for all
// LLM interaction and Discord delivery.
//
// Two-step turn (same shape as the Rambly OpenClaw thread-linked
// plugin):
//   1. Best-effort mirror the user transcript when an explicit delivery
//      target is present, explicit handoff target + sessionKey expose a
//      provider target, sessionKey or a legacy colon-style Discord session
//      key exposes a safe target, or an actual OpenClaw sessionId can be
//      reverse-resolved to a Discord session key.
//   2. Run `openclaw agent --agent <session-key-agent> --session-id <session>
//      --deliver --reply-channel <channel> --reply-to <target> -m ...`.
//      The agent receives the full transcript in its own message payload, so
//      reply generation does not depend on the transcript post completing.
//      OpenClaw delivery posts the assistant reply; the daemon captures stdout
//      for TTS and does not mirror the assistant text with `openclaw message send`.
//      Exception: thread-addressed Slack targets (session keys like
//      `agent:<a>:slack:channel:<C>:thread:<ts>`) cannot ride
//      `--reply-to`, so the daemon posts both transcript and reply into
//      the thread via `openclaw message send --thread-id <ts>`.
//
// The daemon never calls xAI directly. Debug activity notifications
// are sent before/after key events (STT start/stop, TTS start/stop,
// etc.) and never embed the agent reply text.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execFileAsync = promisify(execFile);

export interface ChatErrorDetails {
  rootMessage?: string;
  stderr?: string;
  exitCode?: string;
}

const BENIGN_AUTH_PROFILE_DIAGNOSTIC = /^\s*\[agents\/auth-profiles\].*$/gim;

const VOICE_REPLY_GUIDANCE =
  'Your reply will be turned back into a voice message for the user, so keep it concise ' +
  'by default but complete enough when needed, and read-aloud friendly. Return text only; ' +
  'do not call TTS/media tools, emit MEDIA directives, or return media paths. Avoid markdown, lists, and code blocks.';

const RAW_STT_GUIDANCE =
  'The following is a raw speech-to-text transcript from the user. It may contain ' +
  "mistranscriptions, missing punctuation, or incorrect words. Use your best judgment to infer the user's " +
  'intended meaning and actual spoken words before replying.';

const WEBCHAT_BASE_SESSION_KEY = 'agent:main:webchat';
const WEBCHAT_LAST_SESSION_KEY = 'agent:main:main';
const SESSION_KEY_PREFIX = 'agent:';

// Helper: send a debug/activity notification to the Discord thread
async function sendDebugNotification(
  threadId: string | undefined,
  message: string,
): Promise<void> {
  if (!threadId) return; // no thread to notify
  try {
    const args = [
      'message', 'send',
      '--channel', 'discord',
      '--target', `channel:${threadId}`,
      '--message', `> _clawkie ${message}`,
    ];
    await execFileAsync('openclaw', args);
  } catch {
    // debug notifications are best-effort — don't fail the turn
  }
}

async function sendTranscriptMessage(
  opts: {
    threadId?: string;
    sessionId: string;
    sessionKey?: string;
    channel?: string;
    target?: string;
    accountId?: string;
    delivery?: DeliveryTarget;
  },
  transcript: string,
  signal?: AbortSignal,
): Promise<void> {
  const sessionKeyForThread = opts.sessionKey || opts.sessionId;
  const delivery = await resolveDeliveryTargetAccountId(opts.delivery, opts);
  if (delivery) {
    await sendGenericMessage(
      withSlackSessionKeyThread(delivery, sessionKeyForThread),
      quoteTranscript(transcript),
      signal,
      'openclaw_transcript_post_failed',
    );
    return;
  }
  const explicitTarget = await resolveDeliveryTargetAccountId(deriveMessageTargetFromHandoff(opts), opts);
  if (explicitTarget) {
    await sendGenericMessage(
      withSlackSessionKeyThread(explicitTarget, sessionKeyForThread),
      quoteTranscript(transcript),
      signal,
      'openclaw_transcript_post_failed',
    );
    return;
  }

  const target = await resolveDeliveryTargetAccountId(deriveDiscordDeliveryTarget({
    threadId: opts.threadId,
    sessionId: opts.sessionKey || opts.sessionId,
  }), opts);
  if (!target) {
    const resolved = await resolveDiscordDeliveryTargetFromSessionLookup(opts.sessionId, signal);
    if (!resolved) return;
    const resolvedTargetWithAccount = await resolveDeliveryTargetAccountId(
      resolved.delivery,
      { ...opts, resolvedSessionKey: resolved.sessionKey },
    );
    if (!resolvedTargetWithAccount) return;
    await sendGenericMessage(
      resolvedTargetWithAccount,
      quoteTranscript(transcript),
      signal,
      'openclaw_transcript_post_failed',
    );
    return;
  }
  await sendGenericMessage(target, quoteTranscript(transcript), signal, 'openclaw_transcript_post_failed');
}

async function sendGenericMessage(
  delivery: DeliveryTarget,
  message: string,
  signal: AbortSignal | undefined,
  failureLabel: string,
): Promise<void> {
  const args = [
    'message', 'send',
    '--channel', delivery.channel,
    '--target', delivery.target,
    ...(delivery.accountId ? ['--account', delivery.accountId] : []),
    ...(delivery.threadId ? ['--thread-id', delivery.threadId] : []),
    '--message', message,
  ];
  try {
    await execFileAsync('openclaw', args, { signal });
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    throw toOpenClawChatError(err, failureLabel);
  }
}

export function quoteTranscript(transcript: string): string {
  // Plain Discord block-quote: each transcript line gets a leading `> `,
  // no header. Discord-bound agent sessions post the agent reply
  // themselves; the transcript message is the only thing the daemon
  // writes for the user side of the turn, so an explicit "User said:"
  // header would just add noise.
  return transcript
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function deriveMessageTargetFromHandoff(opts: {
  channel?: string;
  target?: string;
  accountId?: string;
  sessionKey?: string;
  sessionId: string;
}): DeliveryTarget | undefined {
  const target = opts.target?.trim();
  if (!target) return undefined;

  const channel = opts.channel?.trim() || deriveChannelFromSessionKey(opts.sessionKey || opts.sessionId);
  if (!channel) return undefined;
  const accountId = opts.accountId?.trim();
  return { channel, target, ...(accountId ? { accountId } : {}) };
}

function deriveChannelFromSessionKey(sessionKey: string | undefined): string | undefined {
  const key = sessionKey?.trim();
  if (!key?.startsWith('agent:')) return undefined;

  const parts = key.split(':').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return undefined;
  return parts[2];
}

// Internal OpenClaw surfaces with no external chat channel. Voice turns
// for these run without `--deliver`: the reply only goes back over TTS.
const NON_DELIVERED_CHANNELS = new Set(['webchat', 'main']);

export function shouldDeliverReplyForChatTarget(opts: {
  sessionId: string;
  sessionKey?: string;
  channel?: string;
}): boolean {
  const channel = opts.channel?.trim() || deriveChannelFromSessionKey(opts.sessionKey || opts.sessionId);
  return !channel || !NON_DELIVERED_CHANNELS.has(channel);
}

export function deriveDiscordMessageTarget(opts: {
  threadId?: string;
  sessionId: string;
}): string | undefined {
  const target = deriveDiscordDeliveryTarget(opts)?.target;
  return target?.startsWith('channel:') ? target.slice('channel:'.length) : undefined;
}

function deriveDiscordDeliveryTarget(opts: {
  threadId?: string;
  sessionId: string;
}): DeliveryTarget | undefined {
  const explicitThreadId = opts.threadId?.trim();
  if (explicitThreadId) return { channel: 'discord', target: `channel:${explicitThreadId}` };

  const target = deriveDiscordTargetFromSessionKey(opts.sessionId);
  return target ? { channel: 'discord', target } : undefined;
}

function deriveDiscordTargetFromSessionKey(sessionId: string): string | undefined {
  const parts = sessionId
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'agent' || parts[2] !== 'discord') return undefined;

  const kind = parts[3];
  const id = parts.at(-1);
  if (!id || id === kind) return undefined;

  if (kind === 'direct' || kind === 'user') return `user:${id}`;
  if (kind === 'channel' || kind === 'thread') return `channel:${id}`;

  const legacyIds = parts
    .slice(3)
    .filter((part) => !['channel', 'thread', 'message', 'guild'].includes(part));
  const legacyId = legacyIds.at(-1);
  return legacyId ? `channel:${legacyId}` : undefined;
}

// Slack threads hang off a parent-channel message: the route is the
// parent channel target plus the anchor message ts as the thread id.
// OpenClaw keys such sessions `agent:<a>:slack:channel:<C>:thread:<ts>`
// (plain channel sessions stop at `channel:<C>`).
const SAFE_SLACK_CHANNEL_ID = /^[A-Za-z0-9_-]+$/;
const SLACK_THREAD_TS = /^\d+\.\d+$/;

export function deriveSlackDeliveryFromSessionKey(
  sessionKey: string | undefined,
): DeliveryTarget | undefined {
  const parts = (sessionKey ?? '')
    .split(':')
    .map((part) => part.trim());
  if (parts.length < 5 || parts[0] !== 'agent' || parts[2] !== 'slack' || parts[3] !== 'channel') {
    return undefined;
  }
  const channelId = parts[4];
  if (!channelId || !SAFE_SLACK_CHANNEL_ID.test(channelId)) return undefined;
  const delivery: DeliveryTarget = { channel: 'slack', target: `channel:${channelId}` };
  if (parts[5] === 'thread') {
    const threadTs = parts.slice(6).join(':');
    if (!SLACK_THREAD_TS.test(threadTs)) return undefined;
    delivery.threadId = threadTs;
  } else if (parts.length > 5) {
    // Unrecognized session-key suffix: don't guess a route from it.
    return undefined;
  }
  return delivery;
}

// Explicit handoff/delivery targets carry the parent channel but not
// the thread ts (it only lives in the session key). When the explicit
// slack target matches the session key's parent channel, attach the
// thread id so transcript + reply land in the thread instead of the
// channel. Mismatched explicit routes are preserved untouched.
function withSlackSessionKeyThread<T extends DeliveryTarget>(
  delivery: T,
  sessionKey: string | undefined,
): T {
  if (delivery.channel !== 'slack' || delivery.threadId) return delivery;
  const derived = deriveSlackDeliveryFromSessionKey(sessionKey);
  if (!derived?.threadId || derived.target !== delivery.target) return delivery;
  return { ...delivery, threadId: derived.threadId };
}

async function resolveDiscordDeliveryTargetFromSessionLookup(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ delivery: DeliveryTarget; sessionKey: string } | undefined> {
  const requested = sessionId.trim();
  if (!isUuidLikeSessionId(requested)) return undefined;

  const key = await lookupOpenClawSessionKey(requested, signal);
  if (!key) return undefined;
  const delivery = deriveDiscordDeliveryTarget({ sessionId: key });
  return delivery ? { delivery, sessionKey: key } : undefined;
}

function isUuidLikeSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId);
}

async function lookupOpenClawSessionKey(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await lookupOpenClawSessionKeyRequired(sessionId, signal);
  } catch {
    // Transcript mirroring lookup is best-effort. Mandatory reply delivery
    // and agent metadata resolution use lookupOpenClawSessionKeyRequired so
    // OpenClaw CLI/gateway/auth failures keep their useful classification.
    return undefined;
  }
}

async function lookupOpenClawSessionKeyRequired(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const args = ['sessions', '--json', '--all-agents', '--active', '10080'];
  try {
    const { stdout } = await execFileAsync('openclaw', args, { signal });
    return findSessionKeyForSessionId(stdout, sessionId);
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    throw toOpenClawChatError(err, 'openclaw_sessions_lookup_failed');
  }
}

function findSessionKeyForSessionId(stdout: string, sessionId: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const candidateSessionId = readStringProperty(row, 'sessionId') ?? readStringProperty(row, 'id');
    if (candidateSessionId !== sessionId) continue;
    const key = readStringProperty(row, 'key') ?? readStringProperty(row, 'sessionKey');
    const trimmedKey = key?.trim();
    if (trimmedKey) return trimmedKey;
  }
  return undefined;
}

// Helper: get assistant reply text. The agent receives the full raw-STT
// transcript in its own `-m` payload and OpenClaw delivers the assistant
// reply to an explicit reply target. Legacy transcript posting is a
// separate fire-and-observe side effect, not a prerequisite for reply
// generation.
async function runOpenClawTurn(opts: {
  sessionId: string;
  threadId?: string;
  userText: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: DeliveryTarget;
  deliver?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const message = buildAgentTurnMessage(opts.userText);
  const sessionId = await resolveOpenClawAgentSessionId(opts.sessionId);
  const shouldDeliver = opts.deliver !== false;
  const resolvedSessionKey = await resolveAgentSessionKeyMetadata({ ...opts, requireLookup: shouldDeliver });
  const agentId = deriveAgentIdFromSessionKey(resolvedSessionKey) ?? 'main';
  const replyTarget = shouldDeliver ? await resolveAgentReplyTarget({ ...opts, resolvedSessionKey, requireLookup: shouldDeliver }) : undefined;
  if (shouldDeliver && !replyTarget) {
    throw new ChatError('openclaw_delivery_unresolved', 'openclaw_delivery_unresolved');
  }
  // Thread-addressed targets (Slack thread ts) cannot ride the agent
  // CLI's `--reply-to <target>` route — the thread id is not a target —
  // so the daemon posts the reply itself with `message send
  // --thread-id` after the turn. Reply delivery stays mandatory: a
  // failed post fails the turn like a failed `--deliver` would.
  const daemonPostsReply = Boolean(replyTarget?.threadId);
  const args = [
    'agent',
    '--agent', agentId,
    '--session-id', sessionId,
    ...(shouldDeliver && replyTarget && !daemonPostsReply
      ? [
          '--deliver',
          '--reply-channel', replyTarget.channel,
          '--reply-to', replyTarget.target,
          ...(replyTarget.accountId ? ['--reply-account', replyTarget.accountId] : []),
        ]
      : []),
    '--json',
    '-m', message,
  ];

  try {
    const { stdout } = await execFileAsync('openclaw', args, { signal: opts.signal });
    const parsed = parseOpenClawAgentJson(stdout);
    const { text, hasMedia } = extractReplyFromAgentJson(parsed);
    if (!text && hasMedia) {
      throw new ChatError('openclaw_media_reply_unavailable', 'openclaw_media_reply_unavailable');
    }
    if (!text) {
      throw new ChatError('openclaw_reply_empty', 'openclaw_reply_empty');
    }
    if (shouldDeliver && replyTarget && daemonPostsReply) {
      await sendGenericMessage(replyTarget, text, opts.signal, 'openclaw_reply_post_failed');
    }
    return text;
  } catch (err: unknown) {
    if (err instanceof ChatError) throw err;
    if (opts.signal?.aborted) throw new ChatError('aborted', 'aborted');
    throw toOpenClawChatError(err, 'openclaw_failed');
  }
}

interface OpenClawAgentJsonPayload {
  text?: string;
  mediaUrl?: string | null;
  mediaUrls?: string[];
}

interface OpenClawAgentJsonResponse {
  result?: { payloads?: OpenClawAgentJsonPayload[] };
  payloads?: OpenClawAgentJsonPayload[];
}

function parseOpenClawAgentJson(stdout: string): OpenClawAgentJsonResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ChatError('openclaw_reply_unparseable', 'openclaw_reply_unparseable');
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      throw new ChatError('openclaw_reply_unparseable', 'openclaw_reply_unparseable');
    }
    return parsed as OpenClawAgentJsonResponse;
  } catch (err) {
    if (err instanceof ChatError) throw err;
    throw new ChatError('openclaw_reply_unparseable', 'openclaw_reply_unparseable');
  }
}

function extractReplyFromAgentJson(response: OpenClawAgentJsonResponse): {
  text: string;
  hasMedia: boolean;
} {
  const payloads = Array.isArray(response.result?.payloads)
    ? response.result!.payloads!
    : Array.isArray(response.payloads)
      ? response.payloads
      : [];
  const textParts: string[] = [];
  let hasMedia = false;
  for (const payload of payloads) {
    if (payload && typeof payload.text === 'string' && payload.text.trim()) {
      textParts.push(payload.text.trim());
    }
    if (payload) {
      if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) hasMedia = true;
      if (typeof payload.mediaUrl === 'string' && payload.mediaUrl.trim()) hasMedia = true;
    }
  }
  return { text: textParts.join('\n').trim(), hasMedia };
}

function deriveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const key = sessionKey?.trim();
  if (!key?.startsWith('agent:')) return undefined;
  const agent = key.split(':')[1]?.trim();
  return agent || undefined;
}

async function resolveAgentSessionKeyMetadata(opts: {
  sessionId: string;
  sessionKey?: string;
  signal?: AbortSignal;
  requireLookup?: boolean;
}): Promise<string | undefined> {
  const explicitKey = opts.sessionKey?.trim();
  if (explicitKey) return explicitKey;

  const sessionKeyAsSession = opts.sessionId.trim();
  if (sessionKeyAsSession.startsWith(SESSION_KEY_PREFIX)) return sessionKeyAsSession;
  if (!isUuidLikeSessionId(sessionKeyAsSession)) return undefined;

  return opts.requireLookup
    ? lookupOpenClawSessionKeyRequired(sessionKeyAsSession, opts.signal)
    : lookupOpenClawSessionKey(sessionKeyAsSession, opts.signal);
}

async function resolveAgentReplyTarget(opts: {
  threadId?: string;
  sessionId: string;
  sessionKey?: string;
  resolvedSessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: DeliveryTarget;
  signal?: AbortSignal;
  requireLookup?: boolean;
}): Promise<DeliveryTarget | undefined> {
  const sessionKeyForThread = opts.resolvedSessionKey || opts.sessionKey || opts.sessionId;
  const explicitDelivery = await resolveDeliveryTargetAccountId(opts.delivery, opts);
  if (explicitDelivery) return withSlackSessionKeyThread(explicitDelivery, sessionKeyForThread);

  const explicitTarget = await resolveDeliveryTargetAccountId(deriveMessageTargetFromHandoff(opts), opts);
  if (explicitTarget) return withSlackSessionKeyThread(explicitTarget, sessionKeyForThread);

  const threadId = opts.threadId?.trim();
  if (threadId) return resolveDeliveryTargetAccountId({ channel: 'discord', target: `channel:${threadId}` }, opts);

  const fromKey = await resolveDeliveryTargetAccountId(
    deriveReplyTargetFromSessionKey(opts.resolvedSessionKey || opts.sessionKey || opts.sessionId),
    opts,
  );
  if (fromKey) return fromKey;

  const resolvedKey = opts.resolvedSessionKey ?? (opts.requireLookup
    ? await lookupOpenClawSessionKeyRequired(opts.sessionId, opts.signal)
    : await lookupOpenClawSessionKey(opts.sessionId, opts.signal));
  return resolveDeliveryTargetAccountId(deriveReplyTargetFromSessionKey(resolvedKey), { ...opts, resolvedSessionKey: resolvedKey });
}

function normalizeDeliveryTarget(delivery: DeliveryTarget | undefined): DeliveryTarget | undefined {
  if (!delivery) return undefined;
  const channel = delivery.channel.trim();
  const target = delivery.target.trim();
  if (!channel || !target) return undefined;
  const accountId = delivery.accountId?.trim();
  return { channel, target, ...(accountId ? { accountId } : {}) };
}

async function resolveDeliveryTargetAccountId(
  delivery: DeliveryTarget | undefined,
  opts: {
    sessionId: string;
    sessionKey?: string;
    resolvedSessionKey?: string;
    accountId?: string;
    signal?: AbortSignal;
  },
): Promise<DeliveryTarget | undefined> {
  const normalized = normalizeDeliveryTarget(delivery);
  if (!normalized) return undefined;
  if (normalized.accountId) return normalized;

  const explicitAccountId = opts.accountId?.trim();
  if (explicitAccountId) return { ...normalized, accountId: explicitAccountId };

  const metadataAccountId = await resolveSessionAccountIdFromOpenClawStore({
    sessionId: opts.sessionId,
    sessionKey: opts.resolvedSessionKey || opts.sessionKey,
    signal: opts.signal,
  });
  return metadataAccountId ? { ...normalized, accountId: metadataAccountId } : normalized;
}

async function resolveSessionAccountIdFromOpenClawStore(opts: {
  sessionId: string;
  sessionKey?: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const requestedSessionId = opts.sessionId.trim();
  const explicitSessionKey = opts.sessionKey?.trim();
  const sessionKey = explicitSessionKey
    || (requestedSessionId.startsWith(SESSION_KEY_PREFIX)
      ? requestedSessionId
      : isUuidLikeSessionId(requestedSessionId)
        ? await lookupOpenClawSessionKey(requestedSessionId, opts.signal)
        : undefined);
  if (!sessionKey?.startsWith(SESSION_KEY_PREFIX)) return undefined;

  try {
    const record = await readOpenClawSessionRecord(sessionKey, requestedSessionId);
    return readSessionAccountId(record);
  } catch {
    // Account metadata is an optional routing guard. If the local session
    // store is unavailable or malformed, preserve the previous behavior.
    return undefined;
  }
}

function deriveReplyTargetFromSessionKey(sessionKey: string | undefined): DeliveryTarget | undefined {
  const channel = deriveChannelFromSessionKey(sessionKey);
  if (!channel) return undefined;

  if (channel === 'discord' && sessionKey) {
    return deriveDiscordDeliveryTarget({ sessionId: sessionKey });
  }

  if (channel === 'slack' && sessionKey) {
    return deriveSlackDeliveryFromSessionKey(sessionKey);
  }

  return undefined;
}

export async function resolveOpenClawAgentSessionId(sessionId: string): Promise<string> {
  const requested = normalizeOpenClawAgentSessionKey(sessionId);
  if (isSafeOpenClawSessionId(requested)) return requested;
  if (!requested.startsWith(SESSION_KEY_PREFIX)) {
    throw new ChatError('openclaw_session_invalid', 'openclaw_session_invalid');
  }

  const resolved = await resolveSessionKeyFromOpenClawStore(requested);
  if (resolved) return resolved;

  throw new ChatError(
    `OpenClaw session key not found in sessions store: ${requested}`,
    'openclaw_session_unresolved',
  );
}

function normalizeOpenClawAgentSessionKey(sessionId: string): string {
  const requested = sessionId.trim();
  if (!requested) throw new ChatError('openclaw_session_missing', 'openclaw_session_missing');
  return requested === WEBCHAT_BASE_SESSION_KEY ? WEBCHAT_LAST_SESSION_KEY : requested;
}

function isSafeOpenClawSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && !sessionId.includes(':');
}

async function resolveSessionKeyFromOpenClawStore(sessionKey: string): Promise<string | undefined> {
  const record = await readOpenClawSessionRecord(sessionKey);
  const storedSessionId = readStoredSessionId(record);
  if (!storedSessionId) return undefined;
  if (!isSafeOpenClawSessionId(storedSessionId)) {
    throw new ChatError('openclaw_sessions_store_invalid', 'openclaw_sessions_store_invalid');
  }
  return storedSessionId;
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
    throw new ChatError('openclaw_sessions_store_unreadable', 'openclaw_sessions_store_unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatError('openclaw_sessions_store_invalid', 'openclaw_sessions_store_invalid');
  }

  return findSessionRecord(parsed, sessionKey, sessionId);
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
    if (!entry || typeof entry !== 'object') return false;
    if (readStringProperty(entry, 'key') === sessionKey || readStringProperty(entry, 'sessionKey') === sessionKey) return true;
    if (!requestedSessionId) return false;
    return readStringProperty(entry, 'sessionId') === requestedSessionId || readStringProperty(entry, 'id') === requestedSessionId;
  };

  if (Array.isArray(store)) return store.find(matches);

  const direct = (store as Record<string, unknown>)[sessionKey];
  if (direct) return direct;
  return Object.values(store as Record<string, unknown>).find(matches);
}

function readStoredSessionId(record: unknown): string | undefined {
  const value = readStringProperty(record, 'sessionId') ?? readStringProperty(record, 'id');
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readSessionAccountId(record: unknown): string | undefined {
  const value = readStringProperty(record, 'accountId')
    ?? readStringProperty(record, 'account')
    ?? readStringProperty(record, 'lastAccountId')
    ?? readStringProperty(record, 'lastAccount')
    ?? readStringProperty(readObjectProperty(record, 'origin'), 'accountId')
    ?? readStringProperty(readObjectProperty(record, 'origin'), 'account')
    ?? readStringProperty(readObjectProperty(record, 'origin'), 'lastAccountId')
    ?? readStringProperty(readObjectProperty(record, 'origin'), 'lastAccount')
    ?? readStringProperty(readObjectProperty(record, 'deliveryContext'), 'accountId')
    ?? readStringProperty(readObjectProperty(record, 'deliveryContext'), 'account')
    ?? readStringProperty(readObjectProperty(record, 'deliveryContext'), 'lastAccountId')
    ?? readStringProperty(readObjectProperty(record, 'deliveryContext'), 'lastAccount');
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return property && typeof property === 'object' && !Array.isArray(property) ? property as Record<string, unknown> : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT');
}

export function buildAgentTurnMessage(userText: string): string {
  return `${RAW_STT_GUIDANCE}\n\n<raw-stt-transcript>\n${userText}\n</raw-stt-transcript>\n\n${VOICE_REPLY_GUIDANCE}`;
}


export function classifyOpenClawError(err: unknown): string {
  const text = stripBenignOpenClawDiagnostics(collectOpenClawErrorText(err)).toLowerCase();
  if (/\b(command not found|not found|enoent)\b/.test(text)) return 'openclaw_unavailable';
  if (/\bdelivery channel is required\b/.test(text)) return 'openclaw_delivery_unavailable';
  if (/\b(econnrefused|gateway|fetch failed|failed to connect|127\.0\.0\.1|18789)\b/.test(text)) {
    return 'openclaw_gateway_unavailable';
  }
  if (/\b(auth|token|credential|unauthorized|forbidden|device-auth|read-only file system|erofs)\b/.test(text)) {
    return 'openclaw_auth_unavailable';
  }
  return 'openclaw_failed';
}

function collectOpenClawErrorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  if (err && typeof err === 'object') {
    const maybe = err as { code?: unknown; stderr?: unknown; stdout?: unknown };
    if (typeof maybe.code === 'string' || typeof maybe.code === 'number') parts.push(String(maybe.code));
    if (typeof maybe.stderr === 'string') parts.push(maybe.stderr);
    if (typeof maybe.stdout === 'string') parts.push(maybe.stdout);
  }
  return parts.join('\n');
}

function stripBenignOpenClawDiagnostics(text: string): string {
  return text.replace(BENIGN_AUTH_PROFILE_DIAGNOSTIC, '');
}

function toOpenClawChatError(err: unknown, fallbackLabel: string): ChatError {
  const message = err instanceof Error && err.message ? err.message : fallbackLabel;
  return new ChatError(message, classifyOpenClawError(err), extractOpenClawErrorDetails(err, fallbackLabel));
}

function extractOpenClawErrorDetails(err: unknown, fallbackLabel: string): ChatErrorDetails {
  const details: ChatErrorDetails = {};
  if (err instanceof Error && err.message) details.rootMessage = sanitizeOpenClawLogText(err.message);
  if (err && typeof err === 'object') {
    const maybe = err as { code?: unknown; stderr?: unknown };
    if (typeof maybe.stderr === 'string' && maybe.stderr.trim()) {
      details.stderr = sanitizeOpenClawLogText(maybe.stderr);
    }
    if (typeof maybe.code === 'string' || typeof maybe.code === 'number') details.exitCode = String(maybe.code);
  }
  if (!details.rootMessage) details.rootMessage = sanitizeOpenClawLogText(fallbackLabel);
  return details;
}

function sanitizeOpenClawLogText(text: string): string {
  return stripBenignOpenClawDiagnostics(text)
    .replace(/("--message"\s+)"(?:\\.|[^"\\])*"/g, '$1"[redacted]"')
    .replace(/("-m"\s+)"(?:\\.|[^"\\])*"/g, '$1"[redacted]"')
    .replace(/(--message\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/(-m\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g, '$1[redacted]')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|credential|password)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/\b(token-[A-Za-z0-9_.-]+)\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export interface DeliveryTarget {
  channel: string;
  target: string;
  accountId?: string;
  // Provider thread id for targets whose threads are not standalone
  // channels (Slack thread ts). Forwarded as `--thread-id` on
  // `openclaw message send`.
  threadId?: string;
}

export interface ChatOptionsWithSession extends ChatOptions {
  sessionId: string;
  threadId?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: DeliveryTarget;
}

export async function runChat(userText: string, opts: ChatOptionsWithSession): Promise<ChatResult> {
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  const accountId = opts.accountId?.trim() || await resolveSessionAccountIdFromOpenClawStore({
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    signal: opts.signal,
  });

  observeTranscriptPost(
    sendTranscriptMessage(
      {
        threadId: opts.threadId,
        sessionId: opts.sessionId,
        sessionKey: opts.sessionKey,
        channel: opts.channel,
        target: opts.target,
        accountId,
        delivery: opts.delivery,
      },
      trimmed,
      opts.signal,
    ),
  );

  try {
    const reply = await runOpenClawTurn({
      sessionId: opts.sessionId,
      threadId: opts.threadId,
      userText: trimmed,
      sessionKey: opts.sessionKey,
      channel: opts.channel,
      target: opts.target,
      accountId,
      delivery: opts.delivery,
      deliver: opts.deliver,
      signal: opts.signal,
    });

    await sendDebugNotification(opts.threadId, 'reply delivered');

    return { text: reply, source: 'openclaw' };
  } catch (err) {
    // Debug: notify on error
    await sendDebugNotification(
      opts.threadId,
      `error: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    throw err;
  }
}


function observeTranscriptPost(promise: Promise<void>): void {
  void promise.catch((err) => {
    const chatError = err instanceof ChatError ? err : toOpenClawChatError(err, 'openclaw_transcript_post_failed');
    const details = chatError.details;
    const detailText = [details?.rootMessage, details?.stderr]
      .filter((part): part is string => Boolean(part))
      .join(' | ');
    const suffix = detailText ? `: ${sanitizeOpenClawLogText(detailText)}` : '';
    console.error(`[openclaw] transcript_post_failed: ${chatError.code}${suffix}`);
  });
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: ChatErrorDetails,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}
