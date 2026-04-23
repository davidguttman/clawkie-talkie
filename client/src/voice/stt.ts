// Client-side xAI streaming STT.
//
// The protocol side (query params, audio framing, event shapes) is
// verified against the official xAI streaming STT docs. The
// *handshake-auth* side is blocked: xAI does not document a
// browser-compatible auth mechanism for `wss://api.x.ai/v1/stt` with a
// raw API key, so socket creation is routed through `openXaiVoiceSocket`
// which throws `BrowserAuthNotSupportedError` by default. The STT flow
// below is kept intact so that once the auth blocker is resolved
// (daemon-proxied WS, ephemeral-token against `/v1/realtime`, or a
// confirmed subprotocol from xAI) it drops in at a single seam.
//
// Flow (unchanged, runs once a socket can be opened):
//   1. Open WS with query params `sample_rate=16000 encoding=pcm
//      interim_results=true language=<opt>`.
//   2. Wait for `transcript.created` (server ready).
//   3. Start mic via getUserMedia + AudioContext@16k +
//      ScriptProcessorNode; convert Float32 frames to Int16LE and send
//      as raw binary on the WS.
//   4. While recording, fire `onPartial` from every `transcript.partial`.
//   5. `stop()` sends `{"type":"audio.done"}` and awaits
//      `transcript.done` for the final text.

import {
  openXaiVoiceSocket,
  BrowserAuthNotSupportedError,
} from './xaiSocket';

export { BrowserAuthNotSupportedError };

const XAI_STT_WS = 'wss://api.x.ai/v1/stt';
const SAMPLE_RATE = 16000;
// ~100 ms of 16-bit 16 kHz PCM is the pacing the xAI docs sample uses.
const PROCESSOR_BUFFER = 4096;

export class MissingApiKeyError extends Error {
  constructor() {
    super('missing_xai_api_key');
    this.name = 'MissingApiKeyError';
  }
}

export class MicPermissionError extends Error {
  constructor(cause?: unknown) {
    super('mic_denied');
    this.name = 'MicPermissionError';
    if (cause && cause instanceof Error) this.cause = cause;
  }
}

export interface STTHandle {
  // Finalize recording; resolves with the `transcript.done.text`.
  stop(): Promise<string>;
  // Abort without waiting for a transcript. Releases the mic + WS.
  cancel(): void;
}

export interface STTStartOptions {
  apiKey: string;
  language?: string;
  onPartial?: (text: string, isFinal: boolean) => void;
  onError?: (reason: string) => void;
}

interface SttEventPartial {
  type: 'transcript.partial';
  text: string;
  is_final: boolean;
  speech_final: boolean;
}
interface SttEventDone {
  type: 'transcript.done';
  text: string;
}
interface SttEventCreated {
  type: 'transcript.created';
}
interface SttEventError {
  type: 'error';
  message: string;
}
type SttEvent = SttEventCreated | SttEventPartial | SttEventDone | SttEventError;

export async function startXaiSTT(opts: STTStartOptions): Promise<STTHandle> {
  if (!opts.apiKey?.trim()) throw new MissingApiKeyError();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('media_unsupported');
  }

  // Open the socket FIRST so the auth blocker surfaces before we prompt
  // the user for mic permission. Otherwise they'd grant mic access only
  // to hit an auth error.
  const ws = openSttSocket(opts.apiKey, opts.language);

  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    .catch((err) => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      throw new MicPermissionError(err);
    });

  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
    sampleRate: SAMPLE_RATE,
  });
  // Some iOS versions resume AudioContext only after a user gesture —
  // the caller's tap already satisfied that; resume defensively.
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {
      // non-fatal
    }
  }

  // Promise chain: `ready` resolves on transcript.created; `finalTranscript`
  // resolves on transcript.done. stop() awaits finalTranscript.
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (reason: Error) => void;
  const finalTranscript = new Promise<string>((res, rej) => {
    resolveFinal = res;
    rejectFinal = rej;
  });

  let serverReady = false;
  let settled = false;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;

  const cleanup = () => {
    try {
      processor?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      sourceNode?.disconnect();
    } catch {
      // already disconnected
    }
    processor = null;
    sourceNode = null;
    try {
      for (const t of stream.getTracks()) t.stop();
    } catch {
      // ignore
    }
    try {
      void audioCtx.close();
    } catch {
      // ignore
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      // ignore
    }
  };

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: SttEvent;
    try {
      msg = JSON.parse(ev.data) as SttEvent;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'transcript.created':
        if (!serverReady) {
          serverReady = true;
          resolveReady();
        }
        break;
      case 'transcript.partial':
        opts.onPartial?.(msg.text || '', !!msg.is_final);
        break;
      case 'transcript.done':
        if (!settled) {
          settled = true;
          resolveFinal((msg.text || '').trim());
        }
        break;
      case 'error':
        opts.onError?.(msg.message || 'xai_stt_error');
        if (!settled) {
          settled = true;
          rejectFinal(new Error(`xai_stt_error: ${msg.message || 'unknown'}`));
        }
        break;
    }
  });

  ws.addEventListener('close', (ev) => {
    if (!serverReady) rejectReady(new Error(`xai_stt_ws_closed_${ev.code}`));
    if (!settled) {
      settled = true;
      rejectFinal(new Error(`xai_stt_ws_closed_${ev.code}`));
    }
    cleanup();
  });

  ws.addEventListener('error', () => {
    if (!serverReady) rejectReady(new Error('xai_stt_ws_error'));
    if (!settled) {
      settled = true;
      rejectFinal(new Error('xai_stt_ws_error'));
    }
  });

  // Wire the mic graph only after the server is ready so we don't drop
  // leading audio before the session is negotiated.
  try {
    await ready;
  } catch (err) {
    cleanup();
    throw err;
  }

  sourceNode = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
  processor.onaudioprocess = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = floatTo16BitPcm(input);
    try {
      ws.send(pcm);
    } catch {
      // WS may have just closed — the next event will surface it
    }
  };
  sourceNode.connect(processor);
  // ScriptProcessor won't fire unless it's connected to the graph's
  // destination. Route through a muted GainNode so we don't echo mic
  // back through speakers.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(audioCtx.destination);

  return {
    async stop(): Promise<string> {
      // Send audio.done then wait for transcript.done.
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'audio.done' }));
        }
      } catch {
        // ignore — cleanup below
      }
      try {
        return await finalTranscript;
      } finally {
        cleanup();
      }
    },
    cancel() {
      if (!settled) {
        settled = true;
        rejectFinal(new Error('stt_cancelled'));
      }
      cleanup();
    },
  };
}

function openSttSocket(apiKey: string, language?: string): WebSocket {
  const qs = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: 'pcm',
    interim_results: 'true',
  });
  if (language) qs.set('language', language);
  // Routed through the centralized helper. By default this throws
  // BrowserAuthNotSupportedError — see xaiSocket.ts for the blocker.
  return openXaiVoiceSocket({
    endpoint: XAI_STT_WS,
    query: qs,
    apiKey,
  });
}

function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
