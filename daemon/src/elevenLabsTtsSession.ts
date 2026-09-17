// Direct HTTP streaming TTS from ElevenLabs — no CLI child process.
//
// History: the first cut of this module shelled out to the elevenlabs CLI
// (`text-to-speech stream`). In the daemon it failed twice in a row with an
// opaque "HTTP 400" from the CLI (2026-09-17), while identical manual CLI
// calls succeeded — an unexplainable environment difference in the child
// process. Speaking HTTP directly removes that layer, and on any failure
// the actual ElevenLabs error body is visible in the log.
//
// Endpoint: POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000
// First PCM bytes arrive in ~1s (measured) and keep flowing while generation
// continues — versus the old whole-file convert path (~28s+ of silence on
// long replies before any audio).

import { Readable } from 'node:stream';

export const ELEVENLABS_TTS_SAMPLE_RATE = 16000;
const PCM_CHUNK_BYTES = 3200; // 100 ms of mono PCM16 at 16 kHz
const API_BASE = 'https://api.elevenlabs.io/v1';

// OpenClaw's configured speaker voice (gateway tts.providers.elevenlabs.
// speakerVoiceId) — what the previous convert path spoke with.
export const DEFAULT_ELEVENLABS_VOICE_ID = 'Vg61l5AZldKvRrhxEBAU';

export interface ElevenLabsTtsSessionOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
}

export interface ElevenLabsTtsSessionCallbacks {
  onOpen?: () => void;
  onAudio: (pcm: Uint8Array) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export class ElevenLabsTtsSession {
  private readonly abortController = new AbortController();
  private closed = false;
  private doneFired = false;
  private errorFired = false;
  private openedFired = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly opts: ElevenLabsTtsSessionOptions,
    private readonly cb: ElevenLabsTtsSessionCallbacks,
  ) {
    void this.run();
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
  }

  private emitChunks(flush = false): void {
    while (this.pendingBytes >= PCM_CHUNK_BYTES) {
      const frame = Buffer.concat(this.pending, PCM_CHUNK_BYTES);
      this.pending = [frame.subarray(PCM_CHUNK_BYTES)];
      this.pendingBytes -= PCM_CHUNK_BYTES;
      if (!this.closed) this.cb.onAudio(new Uint8Array(frame.subarray(0, PCM_CHUNK_BYTES)));
    }
    if (flush && this.pendingBytes > 0) {
      const tail = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingBytes = 0;
      if (!this.closed) this.cb.onAudio(new Uint8Array(tail));
    }
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (!this.openedFired) {
      this.openedFired = true;
      this.cb.onOpen?.();
    }
    this.emitChunks();
  }

  private async run(): Promise<void> {
    const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
    if (!apiKey) {
      this.fail('ELEVENLABS_API_KEY missing from daemon environment');
      return;
    }
    // The daemon's TtsSelection packs OpenClaw's 'provider/model' composite
    // (e.g. 'elevenlabs/eleven_v3'). The API wants the bare id — 'eleven_v3'.
    // Reproduced 2026-09-17: composite → HTTP 400 invalid voice, bare → 200.
    const rawModel = this.opts.modelId ?? 'eleven_v3';
    const modelId = rawModel.includes('/') ? (rawModel.split('/').pop() ?? rawModel) : rawModel;
    const rawVoice = this.opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
    const voiceId = rawVoice.includes('/') ? (rawVoice.split('/').pop() ?? rawVoice) : rawVoice;
    const url = `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`;
    const body = JSON.stringify({
      text: this.opts.text,
      model_id: modelId,
    });

    // One retry on transient conditions (network error, 429, 5xx). A 400
    // fails fast — the body is logged and the whole-file fallback takes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'content-type': 'application/json',
          },
          body,
          signal: this.abortController.signal,
        });
      } catch (err) {
        if (this.closed) return;
        if (attempt === 0) {
          await delay(500);
          continue;
        }
        this.fail(`stream request failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (this.closed) return;

      if (response.ok) {
        this.cb.onOpen?.();
        this.openedFired = true;
        const stream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
        stream.on('data', (chunk: Buffer) => this.feed(chunk));
        stream.on('end', () => {
          if (this.closed) return;
          this.emitChunks(true);
          this.finish();
        });
        stream.on('error', (err: Error) => this.fail(`stream read failed: ${err.message}`));
        return;
      }

      // Non-OK: read the actual error body for the log.
      const errText = await response.text().catch(() => '');
      const detail = `HTTP ${response.status}: ${errText.slice(0, 400)}`;
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        console.warn(`[elevenlabs-tts] transient ${detail} — retrying once`);
        await delay(500);
        continue;
      }
      this.fail(detail);
      return;
    }
  }

  private finish(): void {
    if (this.doneFired || this.errorFired) return;
    this.doneFired = true;
    this.closed = true;
    this.abortController.abort();
    this.cb.onDone();
  }

  private fail(message: string): void {
    if (this.doneFired || this.errorFired) return;
    this.errorFired = true;
    this.closed = true;
    console.error(`[elevenlabs-tts] ${message}`);
    this.cb.onError(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}