// OpenClaw-integrated chat completions — uses OpenClaw CLI for all
// LLM interaction and Discord delivery.
//
// Patterns from wake-thread.sh:
//   Debug notifications:  openclaw message send --channel discord --target "channel:ID" --message "..."
//   Full turn:          openclaw agent --session-id ... --message ... --deliver --reply-channel discord --reply-to "channel:ID"
//
// The daemon never calls xAI directly. Debug activity notifications are
// sent before/after key events (STT start/stop, TTS start/stop, etc.)

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execAsync = promisify(exec);

const SYSTEM_PROMPT =
  'You are Clawkie, a walky-talky voice assistant. Reply in one or two ' +
  'short spoken sentences — no markdown, no lists, no code blocks.';

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
  opts: { threadId?: string; sessionId: string },
  transcript: string,
  signal?: AbortSignal,
): Promise<void> {
  const target = deriveDiscordMessageTarget(opts);
  if (!target) {
    console.error('[openclaw] transcript_post_skipped: missing_discord_target');
    return;
  }
  const args = [
    'message', 'send',
    '--channel', 'discord',
    '--target', `channel:${target}`,
    '--message', quoteTranscript(transcript),
  ];
  try {
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, {
      env: openClawEnv(apiKey),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : 'openclaw_transcript_post_failed';
    throw new ChatError(msg, classifyOpenClawError(err));
  }
}

export function quoteTranscript(transcript: string): string {
  const quoted = transcript
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `**User said:**\n${quoted}`;
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

// Helper: post user turn as quoted block + get assistant reply
async function runOpenClawTurn(opts: {
  apiKey: string;
  sessionId: string;
  threadId?: string;
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const sessionId = await resolveOpenClawSessionId(opts);
  const message = `User said: "${opts.userText}"\n\nReply as Clawkie: ${SYSTEM_PROMPT}`;
  const args = [
    'agent',
    '--session-id', sessionId,
    '--message', message,
    '--deliver',
  ];
  if (opts.threadId) {
    args.push('--reply-channel', 'discord', '--reply-to', `channel:${opts.threadId}`);
  }

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
    const match = parseOpenClawSessions(stdout).find((entry) => entry.key === requested);
    if (!match?.sessionId) {
      throw new ChatError('openclaw_session_not_found', 'openclaw_session_not_found');
    }
    return match.sessionId;
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

export interface ChatOptionsWithSession extends ChatOptions {
  sessionId: string;
  threadId?: string;
}

export async function runChat(userText: string, opts: ChatOptionsWithSession): Promise<ChatResult> {
  if (!opts.apiKey) throw new ChatError('missing_xai_api_key', 'missing_xai_api_key');
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  await sendTranscriptMessage(
    opts.apiKey,
    { threadId: opts.threadId, sessionId: opts.sessionId },
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

    // Debug: notify that reply was delivered
    await sendDebugNotification(
      opts.apiKey,
      opts.threadId,
      'reply delivered',
    );

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
