// ElevenLabs CLI TTS session — generates 16kHz PCM directly, skipping
// the MP3 encode/decode and 24kHz→16kHz resample pipeline.
//
// The elevenlabs CLI supports output_format=pcm_16000 which gives us
// raw PCM16LE mono at 16kHz — exactly what the Pi client needs.
// This eliminates:
//   1. MP3 encoding on the ElevenLabs side
//   2. ffmpeg MP3→PCM decode on the daemon side
//   3. 24kHz→16kHz linear resampling
//
// Result: faster TTS generation, lower latency, no quality loss from resampling.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ELEVENLABS_TTS_SAMPLE_RATE = 16000;
const PCM_CHUNK_BYTES = 3200; // 100 ms of mono PCM16 at 16 kHz

export interface ElevenLabsTtsSessionOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
  languageCode?: string;
  seed?: number;
  previousText?: string;
  nextText?: string;
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

  private async run(): Promise<void> {
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'clawkie-elevenlabs-tts-'));
      const pcmPath = join(tempDir, 'reply.pcm');

      // Build elevenlabs CLI command
      const args = [
        'text-to-speech', 'convert',
        '--text', this.opts.text,
        '--voice_id', this.opts.voiceId ?? '',
        '--model_id', this.opts.modelId ?? 'eleven_v3',
        '--output_format', 'pcm_16000',
        '--output', pcmPath,
      ];

      if (this.opts.languageCode) {
        args.push('--language_code', this.opts.languageCode);
      }
      if (this.opts.seed !== undefined) {
        args.push('--seed', String(this.opts.seed));
      }
      if (this.opts.previousText) {
        args.push('--previous_text', this.opts.previousText);
      }
      if (this.opts.nextText) {
        args.push('--next_text', this.opts.nextText);
      }

      // Execute elevenlabs CLI
      await this.execElevenLabs(args);

      if (this.closed) return;

      // Read the raw PCM16LE file
      const { readFileSync } = await import('node:fs');
      const pcm = readFileSync(pcmPath);

      if (this.closed) return;

      this.cb.onOpen?.();

      // Stream PCM in 100ms chunks
      for (let offset = 0; offset < pcm.byteLength && !this.closed; offset += PCM_CHUNK_BYTES) {
        this.cb.onAudio(new Uint8Array(pcm.subarray(offset, offset + PCM_CHUNK_BYTES)));
      }

      if (this.closed) return;
      this.finish();
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[elevenlabs-tts] ${message}`);
        this.fail(message);
      }
    } finally {
      if (tempDir) {
        try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  private execElevenLabs(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        'elevenlabs',
        args,
        { signal: this.abortController.signal },
        (error, _stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stderr }));
            return;
          }
          resolve();
        },
      );
    });
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
    this.abortController.abort();
    this.cb.onError(message);
  }
}