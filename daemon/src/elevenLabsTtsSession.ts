// ElevenLabs CLI streaming TTS session — pipes raw PCM16 mono 16kHz chunks
// from `elevenlabs text-to-speech stream` as the audio is generated.
//
// The previous live path (openclaw infer tts convert) generates the whole
// MP3 before returning any bytes — measured ~28s of silence between reply
// text ready and the first audio heard on long replies (2026-09-17). The
// stream subcommand delivers the first PCM bytes in ~1s and keeps flowing.
//
// The CLI needs ELEVENLABS_API_KEY in the daemon environment (daemon .env)
// and an explicit voice_id — default is the OpenClaw speaker voice so the
// streamed voice matches the convert path.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const ELEVENLABS_TTS_SAMPLE_RATE = 16000;
const PCM_CHUNK_BYTES = 3200; // 100 ms of mono PCM16 at 16 kHz

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

function resolveElevenLabsBin(): string {
  // Daemon runs from the repo root (launchd: cd repo && npm run daemon);
  // prefer the pinned local CLI, fall back to PATH.
  const local = join(process.cwd(), 'node_modules', '.bin', 'elevenlabs');
  return existsSync(local) ? local : 'elevenlabs';
}

export class ElevenLabsTtsSession {
  private proc: ChildProcess | null = null;
  private closed = false;
  private doneFired = false;
  private errorFired = false;
  private openedFired = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stderrTail = '';

  constructor(
    private readonly opts: ElevenLabsTtsSessionOptions,
    private readonly cb: ElevenLabsTtsSessionCallbacks,
  ) {
    this.run();
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.proc?.kill('SIGTERM');
  }

  private emitChunks(flush = false): void {
    // Accumulate into PCM_CHUNK_BYTES frames; flush emits the tail.
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
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (!this.openedFired) {
      this.openedFired = true;
      this.cb.onOpen?.();
    }
    this.emitChunks();
  }

  private run(): void {
    const params = {
      text: this.opts.text,
      model_id: this.opts.modelId ?? 'eleven_v3',
      voice_id: this.opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
      output_format: 'pcm_16000',
    };
    let bin: string;
    try {
      bin = resolveElevenLabsBin();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      this.proc = spawn(bin, [
        'text-to-speech', 'stream',
        '--format', 'raw',
        '--params', JSON.stringify(params),
        '-o', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    const proc = this.proc;
    proc.stdout?.on('data', (chunk: Buffer) => this.feed(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-800);
    });
    proc.on('error', (err) => this.fail(`elevenlabs stream spawn failed: ${err.message}`));
    proc.on('close', (code) => {
      if (this.closed) return;
      if (code === 0) {
        this.emitChunks(true);
        this.finish();
      } else {
        this.fail(`elevenlabs stream exited with code ${code}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`);
      }
    });
  }

  private finish(): void {
    if (this.doneFired || this.errorFired) return;
    this.doneFired = true;
    this.closed = true;
    this.proc?.kill('SIGTERM'); // process already exiting; ensure cleanup
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