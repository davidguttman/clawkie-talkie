// Reply provider seam.
//
// Given a finalized user transcript, produce assistant reply text. In the
// target architecture, this call is fulfilled by the local daemon driving
// OpenClaw. For this browser-only slice, we do the simplest thing that
// still demonstrates the xAI key is wired end-to-end:
//
//   1. If the user has an xAI key in Settings, POST once to xAI's
//      OpenAI-compatible chat completions endpoint and speak the response.
//   2. Otherwise (or on any error), fall back to a canned stub so the
//      audible loop still completes.
//
// The daemon/OpenClaw path will replace `createLocalReplyProvider` with a
// DataChannel-backed provider later; the state machine consumes the same
// ReplyProvider interface either way.

export interface ReplyResult {
  text: string;
  // Where the text came from — lets the UI label a fallback so the user
  // knows when the real model didn't answer.
  source: 'xai' | 'stub';
  // Populated when source=stub because of a provider error.
  reason?: string;
}

export type ReplyProvider = (userText: string) => Promise<ReplyResult>;

const XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions';
const XAI_MODEL = 'grok-2-latest';

function stubFor(userText: string, reason?: string): ReplyResult {
  const trimmed = userText.trim();
  const preview = trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed;
  const body = preview
    ? `Heard you say: ${preview}. This is a local stub reply — wire up an xAI key in Settings for a real answer.`
    : `I didn't catch anything that time. Try tapping Start again and speaking a little louder.`;
  return { text: body, source: 'stub', reason };
}

export function createLocalReplyProvider(opts: {
  getApiKey: () => string;
}): ReplyProvider {
  return async (userText) => {
    const apiKey = opts.getApiKey().trim();
    if (!userText.trim()) return stubFor(userText, 'empty_transcript');
    if (!apiKey) return stubFor(userText, 'no_api_key');

    try {
      const res = await fetch(XAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                'You are Clawkie, a walky-talky voice assistant. Reply in one or two short spoken sentences — no markdown, no lists, no code blocks.',
            },
            { role: 'user', content: userText },
          ],
        }),
      });

      if (!res.ok) {
        return stubFor(userText, `xai_http_${res.status}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return stubFor(userText, 'xai_empty_reply');
      return { text, source: 'xai' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'xai_fetch_failed';
      return stubFor(userText, reason);
    }
  };
}
