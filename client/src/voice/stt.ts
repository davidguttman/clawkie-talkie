// xAI-backed speech-to-text.
//
// The previous slice used the browser's Web Speech API. David requires xAI
// STT as the only transcription path — no browser SpeechRecognition
// fallback. This module captures mic audio with MediaRecorder during the
// recording phase and POSTs the resulting blob to xAI's batch STT endpoint
// when the user taps Stop.
//
// Endpoint (confirmed from docs.x.ai/developers/model-capabilities/audio/voice):
//   POST https://api.x.ai/v1/stt
//   Authorization: Bearer <key>
//   multipart/form-data with field `file`, plus optional `model`, `language`.
//   Response JSON: { text: string, ... }
//
// Streaming via wss://api.x.ai/v1/realtime is the voice-agent product, not
// a plain STT stream — out of scope for this slice. Transcription here is
// chunked-on-stop, not streaming; the driving loop surfaces that as a
// "Transcribing…" caption during the THINKING state.

const XAI_STT_ENDPOINT = 'https://api.x.ai/v1/stt';
const XAI_STT_MODEL = 'grok-stt';

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
  // Finalize the recording and return the transcript from xAI. Throws on
  // HTTP / network / parse errors so the driving loop can route to the
  // error state.
  stop(): Promise<string>;
  // Abort without calling xAI. Releases the mic.
  cancel(): void;
}

export interface STTStartOptions {
  apiKey: string;
  // Optional ISO language hint (e.g. "en"). Omit to let xAI detect.
  language?: string;
}

export async function startXaiSTT(opts: STTStartOptions): Promise<STTHandle> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new MissingApiKeyError();
  }
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('media_recorder_unsupported');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new MicPermissionError(err);
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  // Start recording immediately. A small timeslice keeps chunks flowing so
  // a very long turn doesn't accumulate one giant blob in memory.
  recorder.start(1000);

  let settled = false;

  const releaseMic = () => {
    try {
      for (const t of stream.getTracks()) t.stop();
    } catch {
      // already released
    }
  };

  const waitForStop = () =>
    new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });

  return {
    async stop(): Promise<string> {
      if (settled) throw new Error('stt_already_settled');
      settled = true;

      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // recorder may race to inactive — fine
      }
      await waitForStop();
      releaseMic();

      const effectiveType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: effectiveType });
      if (blob.size === 0) throw new Error('empty_audio');

      const form = new FormData();
      form.append('file', blob, `recording.${extForMime(effectiveType)}`);
      form.append('model', XAI_STT_MODEL);
      if (opts.language) form.append('language', opts.language);

      const res = await fetch(XAI_STT_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`xai_stt_http_${res.status}${detail ? ': ' + detail : ''}`);
      }

      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
      };
      return (data.text || '').trim();
    },
    cancel() {
      if (settled) return;
      settled = true;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // ignore
      }
      releaseMic();
    },
  };
}

function pickMimeType(): string | undefined {
  // xAI docs list mp3/wav/mp4/m4a explicitly. Safari's MediaRecorder
  // produces audio/mp4 which lines up; Chrome only produces webm/opus and
  // xAI has been accepting that in practice. If neither is supported we
  // let MediaRecorder pick its default.
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // some browsers throw on invalid input — skip
    }
  }
  return undefined;
}

function extForMime(type: string): string {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg')) return 'mp3';
  return 'bin';
}
