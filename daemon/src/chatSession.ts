// OpenClaw-integrated chat completions.
//
// Patterns from wake-thread.sh:
//   Debug notifications:  openclaw message send --channel discord --target "channel:ID" --message "..."
//   Full turn:          openclaw agent --session-id ... --message ... --deliver --reply-channel discord --reply-to "channel:ID"
//
// OpenClaw/Discord stays the preferred path. If the local OpenClaw CLI,
// gateway, or config is unavailable, the daemon falls back to direct xAI
// chat completions so the phone still receives reply.done and TTS.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChatOptions, ChatResult } from './types.js';

const execAsync = promisify(exec);

const XAI_CHAT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-2-latest';
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

async function runXaiChatCompletion(opts: {
  apiKey: string;
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(XAI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: opts.userText },
        ],
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new ChatError('aborted', 'aborted');
    const msg = err instanceof Error ? err.message : 'xai_fetch_failed';
    throw new ChatError(msg, 'xai_fetch_failed');
  }

  if (!res.ok) {
    throw new ChatError(`xai_http_${res.status}`, `xai_http_${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ChatError('xai_empty_reply', 'xai_empty_reply');
  return text;
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
    if (err instanceof ChatError && err.code === 'aborted') throw err;

    await sendDebugNotification(opts.apiKey, opts.threadId, 'openclaw failed; using xAI fallback');

    try {
      const reply = await runXaiChatCompletion({
        apiKey: opts.apiKey,
        userText: trimmed,
        signal: opts.signal,
      });
      await sendDebugNotification(opts.apiKey, opts.threadId, 'xAI fallback reply generated');
      return { text: reply, source: 'xai' };
    } catch (fallbackErr) {
      const code = fallbackErr instanceof ChatError ? fallbackErr.code : 'xai_fetch_failed';
      await sendDebugNotification(opts.apiKey, opts.threadId, `xAI fallback error: ${code}`);
      throw fallbackErr;
    }
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
