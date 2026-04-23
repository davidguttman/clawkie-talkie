// xAI streaming TTS — terminated in the daemon.
//
// Opens `wss://api.x.ai/v1/tts` with `Authorization: Bearer` (the
// server-side path documented by xAI; the browser has no documented
// auth for this socket). Sends the reply text via `text.delta` +
// `text.done`, decodes each base64 `audio.delta` chunk, and emits raw
// PCM16LE bytes to the caller so they can be forwarded over the
// phone's DataConnection. The wire format on the phone is PCM16LE
// mono @ 24 kHz — same bytes xAI emits.

import WebSocket from 'ws';

const XAI_TTS_WS = 'wss://api.x.ai/v1/tts';
const DEFAULT_VOICE = 'eve';
const DEFAULT_LANGUAGE = 'en';
export const TTS_SAMPLE_RATE = 24000;

export interface TtsSessionOptions {
  apiKey: string;
  text: string;
  voice?: string;
  language?: string;
  sampleRate?: number;
}

export interface TtsSessionCallbacks {
  onOpen?: () => void;
  onAudio: (pcm: Uint8Array) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export class XaiTtsSession {
  private readonly ws: WebSocket;
  private closed = false;
  private doneFired = false;
  private errorFired = false;
  private readonly sampleRate: number;

  constructor(
    private readonly opts: TtsSessionOptions,
    private readonly cb: TtsSessionCallbacks,
  ) {
    if (!opts.apiKey) throw new Error('missing_xai_api_key');
    this.sampleRate = opts.sampleRate || TTS_SAMPLE_RATE;

    const qs = new URLSearchParams({
      language: opts.language || DEFAULT_LANGUAGE,
      voice: opts.voice || DEFAULT_VOICE,
      codec: 'pcm',
      sample_rate: String(this.sampleRate),
    });
    const url = `${XAI_TTS_WS}?${qs.toString()}`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    this.ws.on('open', () => {
      if (this.closed) return;
      try {
        this.ws.send(JSON.stringify({ type: 'text.delta', delta: opts.text }));
        this.ws.send(JSON.stringify({ type: 'text.done' }));
        cb.onOpen?.();
      } catch (err) {
        this.fail(err instanceof Error ? err.message : 'xai_tts_send_failed');
      }
    });

    this.ws.on('message', (raw) => {
      if (this.closed) return;
      let msg: { type?: string; delta?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString('utf8')) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'audio.delta' && typeof msg.delta === 'string') {
        try {
          const bytes = Buffer.from(msg.delta, 'base64');
          if (bytes.byteLength > 0) cb.onAudio(new Uint8Array(bytes));
        } catch {
          // ignore a single bad frame — keep stream alive
        }
        return;
      }
      if (msg.type === 'audio.done') {
        this.finish();
        return;
      }
      if (msg.type === 'error') {
        this.fail(`xai_tts_error:${msg.message || 'unknown'}`);
      }
    });

    this.ws.on('close', (code) => {
      if (this.doneFired || this.errorFired) return;
      this.fail(`xai_tts_ws_closed_${code}`);
    });

    this.ws.on('error', (err) => {
      if (this.closed) return;
      this.fail(err instanceof Error ? err.message : 'xai_tts_ws_error');
    });
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private finish(): void {
    if (this.doneFired || this.errorFired) return;
    this.doneFired = true;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.cb.onDone();
  }

  private fail(message: string): void {
    if (this.doneFired || this.errorFired) return;
    this.errorFired = true;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.cb.onError(message);
  }
}
