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

export type SttServerEvent =
  | SttEventCreated
  | SttEventPartial
  | SttEventDone
  | SttEventError;

// Pure event-dispatch helper for the xAI STT stream.
//
// Two channels of information feed the final hand-off:
//
//   * `transcript.partial` events. While speech is in flight these are
//     low-context guesses; they MUST stay UI-only. Empty partials are
//     dropped entirely so they can't wipe live caption state. The
//     latest non-empty partial is also retained as a last-resort
//     fallback for when both `done` and the committed finals are empty.
//
//   * `transcript.partial { is_final: true }` events. xAI emits these
//     in two patterns:
//       - cumulative: each new final extends the previous one
//         (`hello`, then `hello world`). Treating these as independent
//         segments and concatenating produces `hello hello world`,
//         which is wrong. We dedupe by detecting when the new final
//         starts with the prior cumulative state.
//       - segmented: each new final is an independent utterance
//         (`hello`, then `world`). Concatenate with a space.
//     The result is `bestFinals`, the best fully-committed hypothesis.
//
// On `transcript.done` we hand off ONE transcript to the caller. We
// never fire onDone from a partial — the daemon waits for `done` (or
// the WS close) so chat / Discord / TTS only see the most settled
// hypothesis. Selection prefers, in order:
//
//   1. doneText if it's a strict superset of bestFinals (xAI sometimes
//      returns the full hypothesis here even when finals were segmented).
//   2. bestFinals if doneText is empty, a substring of bestFinals, or
//      bestFinals is itself a strict superset of doneText (the
//      "done is just the last segment" case observed in practice).
//   3. The longer of the two when they're independent.
//   4. The latest non-empty partial as the last fallback if both
//      doneText and bestFinals are empty.
export interface SttHandlerCallbacks {
  onReady: () => void;
  onPartial: (text: string, isFinal: boolean) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
}

export interface SttHandlerState {
  readyFired: boolean;
  doneFired: boolean;
  // All non-empty `is_final: true` partials, in arrival order. Kept
  // for diagnostics / backwards-compat with callers that inspect
  // segment counts; `bestFinals` is the source of truth for selection.
  finals: string[];
  // Best committed hypothesis after dedupe of cumulative finals.
  bestFinals: string;
  // Latest non-empty partial text (final or not). Used as the
  // last-resort fallback when `done` and `bestFinals` are both empty.
  latestPartial: string;
}

export function createSttHandlerState(): SttHandlerState {
  return {
    readyFired: false,
    doneFired: false,
    finals: [],
    bestFinals: '',
    latestPartial: '',
  };
}

export function handleSttEvent(
  state: SttHandlerState,
  msg: SttServerEvent,
  cb: SttHandlerCallbacks,
): void {
  switch (msg.type) {
    case 'transcript.created':
      if (!state.readyFired) {
        state.readyFired = true;
        cb.onReady();
      }
      return;
    case 'transcript.partial': {
      const text = (msg.text || '').trim();
      const isFinal = !!msg.is_final;
      if (!text) return; // drop empty partials/finals — they wipe UI
      state.latestPartial = text;
      if (isFinal) {
        state.finals.push(text);
        state.bestFinals = mergeFinal(state.bestFinals, text);
      }
      cb.onPartial(text, isFinal);
      return;
    }
    case 'transcript.done': {
      if (state.doneFired) return;
      state.doneFired = true;
      const doneText = (msg.text || '').trim();
      cb.onDone(selectFinalTranscript(state, doneText));
      return;
    }
    case 'error':
      cb.onError(msg.message || 'xai_stt_error');
      return;
  }
}

// Merge a fresh `is_final: true` segment into the best-committed
// hypothesis. Detects xAI's cumulative-final pattern (`hello`, then
// `hello world`) so we don't double-concat into `hello hello world`.
export function mergeFinal(prev: string, next: string): string {
  const p = prev.trim();
  const n = next.trim();
  if (!p) return n;
  if (!n) return p;
  if (n === p) return p;
  if (n.startsWith(p)) return n;        // cumulative: next extends prev
  if (p.startsWith(n)) return p;        // server retraction: keep prev
  if (p.endsWith(n) || p.includes(n)) return p; // already inside prev
  return `${p} ${n}`;                   // independent segment
}

// Choose the single transcript handed to chat/TTS/Discord at end of
// turn. Conservative: we never invent text, never reorder, and never
// ship a partial unless both authoritative sources are empty.
export function selectFinalTranscript(
  state: SttHandlerState,
  doneText: string,
): string {
  const dt = doneText.trim();
  const finals = state.bestFinals.trim();
  const partial = state.latestPartial.trim();

  if (!dt && !finals) return partial;
  if (!dt) return finals;
  if (!finals) return dt;

  if (dt === finals) return dt;
  if (dt.startsWith(finals)) return dt;       // done extends finals
  if (finals.startsWith(dt)) return finals;   // done is a prefix of finals
  if (finals.includes(dt)) return finals;     // done is a substring (last-segment case)
  if (dt.includes(finals)) return dt;
  return dt.length >= finals.length ? dt : finals;
}

export class XaiSttSession {
  private readonly ws: WebSocket;
  private readonly handlerState = createSttHandlerState();
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
          break;
        case 'transcript.partial':
          console.error(
            `[stt] xAI transcript.${msg.is_final ? 'FINAL' : 'partial'}: ${JSON.stringify(msg.text || '')}`,
          );
          break;
        case 'transcript.done':
          console.error(
            `[stt] xAI transcript.done: ${JSON.stringify(msg.text || '')} ` +
              `(forwarded ${this.audioBytesIn} bytes in ${this.audioFrameCount} frames, ` +
              `accumulated ${this.handlerState.finals.length} final segments)`,
          );
          break;
        case 'error':
          console.error(`[stt] xAI error: ${msg.message || '(none)'}`);
          break;
      }
      handleSttEvent(this.handlerState, msg, cb);
    });

    this.ws.on('close', (code, reason) => {
      const r = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
      console.error(`[stt] xAI WS close code=${code} reason=${r}`);
      if (!this.closed) {
        this.closed = true;
        if (!this.handlerState.doneFired && !this.handlerState.readyFired) {
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
