// OpenClaw-integrated chat completions — replaces direct xAI calls.
//
// This module sends user turns into the Discord/OpenClaw thread and delivers
// assistant replies back into the same canonical thread, following the
// patterns from scripts/daily-focus/scripts/receiving-code-review.ts.
// The daemon *never* calls xAI directly; it uses `openclaw agent` CLI.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execAsync = promisify(exec);

// Helper to run OpenClaw agent commands
type OpenClawOptions = {
  apiKey: string;
  signal?: AbortSignal;
  sessionId: string;
  threadId?: string;
  deliver?: boolean;
};

async function runOpenClawAgent({
  apiKey,
  signal,
  sessionId,
  threadId,
  deliver = true,
  message,
  toolAllow = [],
  thinking = 'default',
  timeoutSeconds = 0,
}: OpenClawOptions & { message: string; toolAllow?: string[]; thinking?: string; timeoutSeconds?: number }): Promise<ChatResult> {
  const args = ['agent', '--message', message];

  if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (threadId) {
    args.push('--thread-id', threadId);
  }
  if (deliver) {
    args.push('--deliver');
  }
  if (thinking && thinking !== 'default') {
    args.push('--thinking', thinking);
  }
  if (timeoutSeconds > 0) {
    args.push('--timeout-seconds', String(timeoutSeconds));
  }
  if (toolAllow.length > 0) {
    args.push('--tools-allow', toolAllow.join(','));
  }

  // NOTE: the OpenClaw agent CLI reads the xAI key from environment variables
  // (or configuration). We pass it via env here so the CLI can use it.
  const env = { XAI_API_KEY: apiKey, ...process.env };

  try {
    const { stdout, stderr } = await execAsync('openclaw', args, { env, signal });
    // The CLI delivers its reply into the canonical thread; we may optionally
    // parse stdout for metadata. For now, capture it as the source text.
    return { text: stdout.trim(), source: 'xai_via_openclaw' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'openclaw_failed';
    throw new ChatError(message, 'openclaw_failed');
  }
}

const SYSTEM_PROMPT =
  'You are Clawkie, a walky-talky voice assistant. Reply in one or two ' +
  'short spoken sentences — no markdown, no lists, no code blocks.';

export interface ChatOptionsWithSession extends ChatOptions {
  sessionId: string;
  threadId?: string;
  deliver?: boolean;
}

export async function runChat(userText: string, opts: ChatOptionsWithSession): Promise<ChatResult> {
  if (!opts.apiKey) throw new ChatError('missing_xai_api_key', 'missing_xai_api_key');
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  // Post user turn into the canonical Discord thread via OpenClaw
  await runOpenClawAgent({
    apiKey: opts.apiKey,
    signal: opts.signal,
    sessionId: opts.sessionId,
    threadId: opts.threadId,
    deliver: opts.deliver ?? true,
    message: `User: ${trimmed}`,
    thinking: 'concise',
  });

  // Request assistant reply via OpenClaw, delivered into the same thread
  const result = await runOpenClawAgent({
    apiKey: opts.apiKey,
    signal: opts.signal,
    sessionId: opts.sessionId,
    threadId: opts.threadId,
    deliver: true,
    message: `Assistant: respond to the user following ${SYSTEM_PROMPT}`,
    thinking: 'default',
  });

  return result;
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
