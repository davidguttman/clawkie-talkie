// xAI streaming STT session.
//
// Opens `wss://api.x.ai/v1/stt` with an `Authorization: Bearer` header —
// the server-side auth path documented by xAI. Forwards inbound raw
// PCM16 frames from the phone into the xAI WS, and relays
// transcript.partial / transcript.done events back via the provided
// callbacks so the RTC layer can publish them over `ct-control`.
//
// One STT session is opened per `stt.start` control frame. Closing the
// session (stt.cancel, RTC disconnect, or xAI `transcript.done`) tears
// down the WS cleanly.

import WebSocket from 'ws';

export interface SttSessionCallbacks {
  onReady: () => void;
  onPartial: (text: string, isFinal: boolean) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

export interface SttSessionOptions {
  apiKey: string;
  sampleRate?: number;
  language?: string;
  interimResults?: boolean;
}

const XAI_STT_WS = 'wss://api.x.ai/v1/stt';

interface SttEventPartial {
  type: 'transcript.partial';
  text?: string;
  is_final?: boolean;
}
interface SttEventDone {
  type: 'transcript.done';
  text?: string;
}
interface SttEventCreated {
  type: 'transcript.created';
}
interface SttEventError {
  type: 'error';
  message?: string;
}

type SttServerEvent = SttEventCreated | SttEventPartial | SttEventDone | SttEventError;

export class XaiSttSession {
  private readonly ws: WebSocket;
  private readyFired = false;
  private doneFired = false;
  private closed = false;

  private audioBytesIn = 0;
  private audioFrameCount = 0;

  constructor(
    private readonly opts: SttSessionOptions,
    private readonly cb: SttSessionCallbacks,
  ) {
    const qs = new URLSearchParams({
      sample_rate: String(opts.sampleRate ?? 16000),
      encoding: 'pcm',
      interim_results: String(opts.interimResults ?? true),
    });
    // Default to English unless caller set it. xAI's own docs sample
    // uses `language=en`; auto-detect on very short clips ("hi") is
    // known-fragile and has empirically returned empty transcripts.
    qs.set('language', opts.language || 'en');
    const url = `${XAI_STT_WS}?${qs.toString()}`;
    console.error(`[stt] opening xAI STT WS ${url}`);

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });

    this.ws.on('open', () => {
      console.error('[stt] xAI WS open');
    });

    this.ws.on('message', (raw) => {
      if (this.closed) return;
      let msg: SttServerEvent;
      try {
        msg = JSON.parse(raw.toString('utf8')) as SttServerEvent;
      } catch {
        console.error('[stt] non-JSON xAI message', raw.toString('utf8').slice(0, 120));
        return;
      }
      switch (msg.type) {
        case 'transcript.created':
          console.error('[stt] xAI transcript.created');
          if (!this.readyFired) {
            this.readyFired = true;
            cb.onReady();
          }
          return;
        case 'transcript.partial': {
          const text = msg.text || '';
          const flag = msg.is_final ? 'FINAL' : 'partial';
          console.error(`[stt] xAI transcript.${flag}: ${JSON.stringify(text)}`);
          cb.onPartial(text, !!msg.is_final);
          return;
        }
        case 'transcript.done':
          console.error(
            `[stt] xAI transcript.done: ${JSON.stringify(msg.text || '')} ` +
              `(forwarded ${this.audioBytesIn} bytes in ${this.audioFrameCount} frames)`,
          );
          if (!this.doneFired) {
            this.doneFired = true;
            cb.onDone((msg.text || '').trim());
          }
          return;
        case 'error':
          console.error(`[stt] xAI error: ${msg.message || '(none)'}`);
          cb.onError(msg.message || 'xai_stt_error');
          return;
      }
    });

    this.ws.on('close', (code, reason) => {
      const r = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
      console.error(`[stt] xAI WS close code=${code} reason=${r}`);
      if (!this.closed) {
        this.closed = true;
        if (!this.doneFired && !this.readyFired) {
          cb.onError(`xai_stt_ws_closed_${code}`);
        }
        cb.onClosed();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[stt] xAI WS error: ${err instanceof Error ? err.message : String(err)}`);
      if (this.closed) return;
      cb.onError(err instanceof Error ? err.message : 'xai_stt_ws_error');
    });
  }

  sendAudio(bytes: Uint8Array): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      // Copy into a fresh Node Buffer of exact length so there's no
      // ambiguity passing browser-origin Uint8Arrays (which can be
      // views over larger ArrayBuffers) to the `ws` library.
      const buf = Buffer.allocUnsafe(bytes.byteLength);
      buf.set(bytes);
      this.ws.send(buf);
      this.audioBytesIn += bytes.byteLength;
      this.audioFrameCount += 1;
      if (this.audioFrameCount === 1 || this.audioFrameCount % 25 === 0) {
        console.error(
          `[stt] forwarded ${this.audioFrameCount} audio frames ` +
            `(${this.audioBytesIn} bytes total)`,
        );
      }
    } catch (err) {
      console.error(`[stt] ws.send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  signalAudioDone(): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: 'audio.done' }));
    } catch {
      // ignore
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
