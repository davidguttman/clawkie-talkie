// xAI chat completions — one-shot, server-side.
//
// The daemon terminates the xAI API so the browser never sees a key.
// V1 keeps this non-streaming: a single POST returns the full reply.
// Streaming tokens can be layered on later without changing the wire
// protocol the phone consumes (`reply.done` / `reply.error`).

const XAI_CHAT_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-2-latest';
const SYSTEM_PROMPT =
  'You are Clawkie, a walky-talky voice assistant. Reply in one or two ' +
  'short spoken sentences — no markdown, no lists, no code blocks.';

export interface ChatOptions {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  source: 'xai';
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

export async function runChat(userText: string, opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new ChatError('missing_xai_api_key', 'missing_xai_api_key');
  const trimmed = userText.trim();
  if (!trimmed) throw new ChatError('empty_transcript', 'empty_transcript');

  let res: Response;
  try {
    res = await fetch(XAI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || DEFAULT_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: trimmed },
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
  return { text, source: 'xai' };
}
