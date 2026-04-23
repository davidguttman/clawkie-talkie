// Centralized xAI WebSocket opener — isolated here so the rest of the
// streaming STT/TTS code stays reusable while the browser-auth story is
// unresolved.
//
// Verified blocker (supervisor-confirmed against official xAI docs):
//
//   • `wss://api.x.ai/v1/stt` and `wss://api.x.ai/v1/tts` document only
//     server-side `Authorization: Bearer <key>` auth, and explicitly say
//     "Never expose your API key in client-side code. Always proxy
//     WebSocket connections through your backend."
//   • The browser-compatible `xai-client-secret.<token>` subprotocol is
//     documented only for `wss://api.x.ai/v1/realtime`, not for /stt or
//     /tts.
//   • There is no documented raw-API-key browser path for /stt or /tts.
//
// `openXaiVoiceSocket` therefore defaults to **throwing**
// `BrowserAuthNotSupportedError`. Callers must treat this as a hard
// blocker and surface it to the UI. There is a clearly-fenced escape
// hatch for local experimentation only (`allowUnverifiedAuth: true` plus
// env flag `VITE_CT_UNVERIFIED_WS_AUTH=1`) that attempts the guessed
// `Sec-WebSocket-Protocol: xai-bearer,<key>` handshake. It is labeled
// UNVERIFIED, gated off by default, and must not be used for release.

export class BrowserAuthNotSupportedError extends Error {
  constructor(endpoint: string) {
    super(
      `browser_ws_auth_not_documented: ${endpoint} — xAI docs do not ` +
        'publish a browser-compatible auth mechanism for raw API keys on ' +
        'this endpoint. Resolve the blocker (daemon proxy, ephemeral ' +
        'token via /v1/realtime, or confirmed subprotocol from xAI) ' +
        'before opening this socket.',
    );
    this.name = 'BrowserAuthNotSupportedError';
  }
}

export interface OpenXaiVoiceSocketOptions {
  endpoint: string;
  query: URLSearchParams;
  apiKey: string;
  // Escape hatch. Defaults to false. Even when true, the env flag
  // `VITE_CT_UNVERIFIED_WS_AUTH=1` must also be set to arm the guessed
  // handshake. Intended for isolated local experimentation, not merge.
  allowUnverifiedAuth?: boolean;
}

export function openXaiVoiceSocket(opts: OpenXaiVoiceSocketOptions): WebSocket {
  const url = `${opts.endpoint}?${opts.query.toString()}`;

  if (!opts.apiKey?.trim()) {
    // Callers already guard on this; throw a distinct error anyway so a
    // missing key can't slip through as a "browser_ws_auth_not_documented".
    throw new Error('missing_xai_api_key');
  }

  if (opts.allowUnverifiedAuth && envFlagUnverifiedAuth()) {
    // UNVERIFIED PATH — see file header. Kept in one place so it is
    // trivially ripped out the moment we have a real answer.
    return new WebSocket(url, unverifiedSubprotocol(opts.apiKey));
  }

  throw new BrowserAuthNotSupportedError(opts.endpoint);
}

function envFlagUnverifiedAuth(): boolean {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
    const v = meta.env?.VITE_CT_UNVERIFIED_WS_AUTH;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

// Kept as a named constant so grep finds every site that uses the
// unverified shape in one place.
function unverifiedSubprotocol(apiKey: string): string[] {
  return ['xai-bearer', apiKey];
}
