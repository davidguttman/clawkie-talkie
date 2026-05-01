// OpenClaw-integrated chat completions — uses OpenClaw CLI for all
// LLM interaction and Discord delivery.
//
// Two-step turn (same shape as the Rambly OpenClaw thread-linked
// plugin):
//   1. Best-effort mirror the user transcript when the target can be derived from the session.
//   2. Run `openclaw agent --agent main --session-id <session>
//      --channel last --deliver -m ...`. The agent receives the full
//      transcript in its own message payload, so reply generation does not
//      depend on the transcript post completing. OpenClaw delivery posts
//      the assistant reply; the daemon captures stdout for TTS and does
//      not mirror the assistant text with `openclaw message send`.
//
// The daemon never calls xAI directly. Debug activity notifications
// are sent before/after key events (STT start/stop, TTS start/stop,
// etc.) and never embed the agent reply text.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execAsync = promisify(exec);

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
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`);
  } catch {
    // debug notifications are best-effort — don't fail the turn
  }
}

async function sendTranscriptMessage(
  opts: { threadId?: string; sessionId: string; delivery?: DeliveryTarget },
  transcript: string,
  signal?: AbortSignal,
): Promise<void> {
  if (opts.delivery) {
    await sendGenericMessage(
      opts.delivery,
      quoteTranscript(transcript),
      signal,
      'openclaw_transcript_post_failed',
    );
    return;
  }
  const target = deriveDiscordMessageTarget(opts);
  if (!target) {
    console.error('[openclaw] transcript_post_skipped: missing_discord_target');
    return;
  }
  await sendDiscordMessage(target, quoteTranscript(transcript), signal, 'openclaw_transcript_post_failed');
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
    '--message', message,
  ];
  try {
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    throw toOpenClawChatError(err, failureLabel);
  }
}

async function sendDiscordMessage(
  target: string,
  message: string,
  signal: AbortSignal | undefined,
  failureLabel: string,
): Promise<void> {
  const args = [
    'message', 'send',
    '--channel', 'discord',
    '--target', `channel:${target}`,
    '--message', message,
  ];
  try {
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, { signal });
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

export function deriveDiscordMessageTarget(opts: {
  threadId?: string;
  sessionId: string;
}): string | undefined {
  const explicitThreadId = opts.threadId?.trim();
  if (explicitThreadId) return explicitThreadId;

  const prefix = 'agent:main:discord:';
  if (!opts.sessionId.startsWith(prefix)) return undefined;

  const ids = opts.sessionId
    .slice(prefix.length)
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part && !['channel', 'thread', 'message', 'guild'].includes(part));

  return ids.at(-1);
}

// Helper: get assistant reply text. The agent receives the full raw-STT
// transcript in its own `-m` payload and uses OpenClaw's channel-last
// delivery path for the assistant reply. Transcript posting is a separate
// fire-and-observe side effect, not a prerequisite for reply generation.
async function runOpenClawTurn(opts: {
  sessionId: string;
  threadId?: string;
  userText: string;
  delivery?: DeliveryTarget;
  signal?: AbortSignal;
}): Promise<string> {
  const message = buildAgentTurnMessage(opts.userText);
  const sessionId = normalizeOpenClawAgentSessionId(opts.sessionId);
  const args = [
    'agent',
    '--agent', 'main',
    '--session-id', sessionId,
    '--channel', 'last',
    '--deliver',
    '--json',
    '-m', message,
  ];

  try {
    const { stdout } = await execAsync(
      `openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`,
      { signal: opts.signal },
    );
    const parsed = parseOpenClawAgentJson(stdout);
    const { text, hasMedia } = extractReplyFromAgentJson(parsed);
    if (!text && hasMedia) {
      throw new ChatError('openclaw_media_reply_unavailable', 'openclaw_media_reply_unavailable');
    }
    if (!text) {
      throw new ChatError('openclaw_reply_empty', 'openclaw_reply_empty');
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

function normalizeOpenClawAgentSessionId(sessionId: string): string {
  const requested = sessionId.trim();
  if (!requested) throw new ChatError('openclaw_session_missing', 'openclaw_session_missing');
  return requested === WEBCHAT_BASE_SESSION_KEY ? WEBCHAT_LAST_SESSION_KEY : requested;
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
    .replace(/(xai[_-]?api[_-]?key\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export interface DeliveryTarget {
  channel: string;
  target: string;
}

export interface ChatOptionsWithSession extends ChatOptions {
  sessionId: string;
  threadId?: string;
  delivery?: DeliveryTarget;
}

export async function runChat(userText: string, opts: ChatOptionsWithSession): Promise<ChatResult> {
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  observeTranscriptPost(
    sendTranscriptMessage(
      { threadId: opts.threadId, sessionId: opts.sessionId, delivery: opts.delivery },
      trimmed,
      opts.signal,
    ),
  );

  try {
    const reply = await runOpenClawTurn({
      sessionId: opts.sessionId,
      threadId: opts.threadId,
      userText: trimmed,
      delivery: opts.delivery,
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
