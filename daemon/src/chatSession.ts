// OpenClaw-integrated chat completions — uses OpenClaw CLI for all
// LLM interaction and Discord delivery.
//
// Two-step turn (same shape as the Rambly OpenClaw thread-linked
// plugin):
//   1. Post the user transcript as a quoted Discord message.
//   2. Run `openclaw agent --session-id agent:main:discord:<target>
//      --message ...`. Discord-bound agent sessions post the reply
//      to the bound channel themselves; we capture stdout only so we
//      can feed the same text to TTS. We do NOT pass --deliver or
//      --reply-to (either causes a duplicate Discord post on top of
//      the session-bound delivery), and we do NOT post the reply
//      explicitly with `openclaw message send` for the same reason.
//
// The daemon never calls xAI directly. Debug activity notifications
// are sent before/after key events (STT start/stop, TTS start/stop,
// etc.) and never embed the agent reply text.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execAsync = promisify(exec);

const VOICE_REPLY_GUIDANCE =
  'Your reply will be turned back into a voice message for the user, so keep it concise ' +
  'by default but complete enough when needed, and read-aloud friendly. Avoid markdown, lists, and code blocks.';

const RAW_STT_GUIDANCE =
  'The following is a raw speech-to-text transcript from the user. It may contain ' +
  "mistranscriptions, missing punctuation, or incorrect words. Use your best judgment to infer the user's " +
  'intended meaning and actual spoken words before replying.';

const WEBCHAT_BASE_SESSION_KEY = 'agent:main:webchat';
const WEBCHAT_CONCRETE_SESSION_PREFIX = `${WEBCHAT_BASE_SESSION_KEY}:`;

// Helper: send a debug/activity notification to the Discord thread
async function sendDebugNotification(
  apiKey: string,
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
    const env = openClawEnv(apiKey);
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, { env });
  } catch {
    // debug notifications are best-effort — don't fail the turn
  }
}

async function sendTranscriptMessage(
  apiKey: string,
  opts: { threadId?: string; sessionId: string; delivery?: DeliveryTarget },
  transcript: string,
  signal?: AbortSignal,
): Promise<void> {
  if (opts.delivery) {
    await sendGenericMessage(
      apiKey,
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
  await sendDiscordMessage(apiKey, target, quoteTranscript(transcript), signal, 'openclaw_transcript_post_failed');
}

async function sendGenericMessage(
  apiKey: string,
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
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, {
      env: openClawEnv(apiKey),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : failureLabel;
    throw new ChatError(msg, classifyOpenClawError(err));
  }
}

async function sendDiscordMessage(
  apiKey: string,
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
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, {
      env: openClawEnv(apiKey),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : failureLabel;
    throw new ChatError(msg, classifyOpenClawError(err));
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

// Helper: get assistant reply text only — never deliver from the
// agent invocation. Discord delivery happens once, separately, via
// `sendReplyMessage` so the agent's session-bound delivery and an
// explicit reply target can't both fire and double-post.
async function runOpenClawTurn(opts: {
  apiKey: string;
  sessionId: string;
  threadId?: string;
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const sessionId = await resolveOpenClawSessionId(opts);
  const message = buildAgentTurnMessage(opts.userText);
  const args = [
    'agent',
    '--session-id', sessionId,
    '--message', message,
  ];

  const env = openClawEnv(opts.apiKey);

  try {
    const { stdout } = await execAsync(
      `openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`,
      { env, signal: opts.signal },
    );
    return stdout.trim();
  } catch (err: unknown) {
    if (opts.signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : 'openclaw_failed';
    throw new ChatError(msg, classifyOpenClawError(err));
  }
}

export function buildAgentTurnMessage(userText: string): string {
  return `${RAW_STT_GUIDANCE}\n\n<raw-stt-transcript>\n${userText}\n</raw-stt-transcript>\n\n${VOICE_REPLY_GUIDANCE}`;
}

async function resolveOpenClawSessionId(opts: {
  apiKey: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const requested = opts.sessionId.trim();
  if (!requested) throw new ChatError('openclaw_session_missing', 'openclaw_session_missing');
  if (!requested.startsWith('agent:')) return requested;

  try {
    const { stdout } = await execAsync(
      'openclaw "sessions" "--json" "--all-agents" "--active" "10080"',
      { env: openClawEnv(opts.apiKey), signal: opts.signal },
    );
    const sessions = parseOpenClawSessions(stdout);
    const exactMatch = sessions.find((entry) => entry.key === requested);
    if (exactMatch?.sessionId) return exactMatch.sessionId;

    if (requested === WEBCHAT_BASE_SESSION_KEY) {
      const webchatMatches = sessions.filter(
        (entry) => entry.sessionId && entry.key.startsWith(WEBCHAT_CONCRETE_SESSION_PREFIX),
      );
      if (webchatMatches.length === 1) return webchatMatches[0].sessionId;
      if (webchatMatches.length > 1) {
        throw new ChatError(
          `openclaw_session_ambiguous: ${requested} matched ${webchatMatches.length} active webchat sessions`,
          'openclaw_session_ambiguous',
        );
      }
    }

    throw new ChatError('openclaw_session_not_found', 'openclaw_session_not_found');
  } catch (err) {
    if (err instanceof ChatError) throw err;
    if (opts.signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : 'openclaw_session_lookup_failed';
    throw new ChatError(msg, classifyOpenClawError(err));
  }
}

function openClawEnv(apiKey: string): NodeJS.ProcessEnv {
  return { ...process.env, XAI_API_KEY: apiKey };
}

function parseOpenClawSessions(stdout: string): Array<{ key: string; sessionId: string }> {
  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const key = (row as { key?: unknown }).key;
    const sessionId = (row as { sessionId?: unknown }).sessionId;
    return typeof key === 'string' && typeof sessionId === 'string' ? [{ key, sessionId }] : [];
  });
}

export function classifyOpenClawError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  if (err && typeof err === 'object') {
    const maybe = err as { code?: unknown; stderr?: unknown; stdout?: unknown };
    if (typeof maybe.code === 'string') parts.push(maybe.code);
    if (typeof maybe.stderr === 'string') parts.push(maybe.stderr);
    if (typeof maybe.stdout === 'string') parts.push(maybe.stdout);
  }
  const text = parts.join('\n').toLowerCase();
  if (/\b(command not found|not found|enoent)\b/.test(text)) return 'openclaw_unavailable';
  if (/\b(auth|token|credential|unauthorized|forbidden|device-auth|read-only file system|erofs)\b/.test(text)) {
    return 'openclaw_auth_unavailable';
  }
  if (/\bdelivery channel is required\b/.test(text)) return 'openclaw_delivery_unavailable';
  if (/\b(econnrefused|gateway|fetch failed|failed to connect|127\.0\.0\.1|18789)\b/.test(text)) {
    return 'openclaw_gateway_unavailable';
  }
  return 'openclaw_failed';
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
  if (!opts.apiKey) throw new ChatError('missing_xai_api_key', 'missing_xai_api_key');
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  await sendTranscriptMessage(
    opts.apiKey,
    { threadId: opts.threadId, sessionId: opts.sessionId, delivery: opts.delivery },
    trimmed,
    opts.signal,
  );

  try {
    const reply = await runOpenClawTurn({
      apiKey: opts.apiKey,
      sessionId: opts.sessionId,
      threadId: opts.threadId,
      userText: trimmed,
      signal: opts.signal,
    });

    // The voice handoff path (rendezvous-bound `delivery`) is not a
    // Discord-bound OpenClaw session, so the agent invocation does
    // *not* mirror its reply back to the originating channel/thread.
    // Post it explicitly here. The legacy `threadId`-only path goes
    // through a Discord-bound agent session that posts the reply
    // itself, so we skip the explicit send to avoid the double-post
    // that prompted the original "no reply send" guard.
    if (opts.delivery) {
      await sendGenericMessage(
        opts.apiKey,
        opts.delivery,
        reply,
        opts.signal,
        'openclaw_reply_post_failed',
      );
    }

    await sendDebugNotification(opts.apiKey, opts.threadId, 'reply delivered');

    return { text: reply, source: 'xai_via_openclaw' };
  } catch (err) {
    // Debug: notify on error
    await sendDebugNotification(
      opts.apiKey,
      opts.threadId,
      `error: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    throw err;
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}
