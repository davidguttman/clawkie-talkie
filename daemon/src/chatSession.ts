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
    const env = { XAI_API_KEY: apiKey, ...process.env };
    await execAsync(`openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`, { env });
  } catch {
    // debug notifications are best-effort — don't fail the turn
  }
}

// Helper: post user turn as quoted block + get assistant reply
async function runOpenClawTurn(opts: {
  apiKey: string;
  sessionId: string;
  threadId?: string;
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const message = `User said: "${opts.userText}"\n\nReply as Clawkie: ${SYSTEM_PROMPT}`;
  const args = [
    'agent',
    '--session-id', opts.sessionId,
    '--message', message,
    '--deliver',
    '--reply-channel', 'discord',
  ];
  if (opts.threadId) {
    args.push('--reply-to', `channel:${opts.threadId}`);
  }

  const env = { XAI_API_KEY: opts.apiKey, ...process.env };

  try {
    const { stdout } = await execAsync(
      `openclaw ${args.map(a => JSON.stringify(a)).join(' ')}`,
      { env, signal: opts.signal },
    );
    return stdout.trim();
  } catch (err: unknown) {
    if (opts.signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : 'openclaw_failed';
    throw new ChatError(msg, 'openclaw_failed');
  }
}

export interface ChatOptionsWithSession extends ChatOptions {
  sessionId: string;
  threadId?: string;
}

export async function runChat(userText: string, opts: ChatOptionsWithSession): Promise<ChatResult> {
  if (!opts.apiKey) throw new ChatError('missing_xai_api_key', 'missing_xai_api_key');
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  // Debug: notify that we received the user's speech
  await sendDebugNotification(
    opts.apiKey,
    opts.threadId,
    `heard: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? '...' : ''}"`,
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
