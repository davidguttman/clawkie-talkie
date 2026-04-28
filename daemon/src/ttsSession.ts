// OpenClaw infer TTS — terminated in the daemon.
//
// The daemon asks the first-party OpenClaw infer CLI to synthesize the
// reply into a temporary MP3 using local transport/default configured
// provider, decodes that MP3 to PCM16LE mono, then forwards the PCM over
// the existing phone TTS path. The phone wire format stays PCM16LE mono
// @ 24 kHz for DataChannel delivery; VoiceSession resamples to 48 kHz
// when feeding the daemon WebRTC audio track.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  synthesizeTtsWithOpenClawInfer,
  type OpenClawInferExec,
} from './openclawInfer.js';

export const TTS_SAMPLE_RATE = 24000;
const FFMPEG_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PCM_CHUNK_BYTES = 4_800; // 100 ms of mono PCM16 at 24 kHz

export interface TtsSessionOptions {
  text: string;
  voice?: string;
  sampleRate?: number;
  synthesize?: SynthesizeTtsFn;
  convertMp3ToPcm?: ConvertMp3ToPcmFn;
  createTempDir?: CreateTempDirFn;
  cleanupTempDir?: CleanupTempDirFn;
  exec?: OpenClawInferExec;
}

export interface TtsSessionCallbacks {
  onOpen?: () => void;
  onAudio: (pcm: Uint8Array) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

type SynthesizeTtsFn = (request: {
  text: string;
  outputPath: string;
  voice?: string;
  signal?: AbortSignal;
  exec?: OpenClawInferExec;
}) => Promise<void>;
type ConvertMp3ToPcmFn = (request: {
  mp3Path: string;
  sampleRate: number;
  signal?: AbortSignal;
}) => Promise<Buffer>;
type CreateTempDirFn = () => Promise<string>;
type CleanupTempDirFn = (path: string) => Promise<void>;

export class OpenClawInferTtsSession {
  private readonly abortController = new AbortController();
  private closed = false;
  private doneFired = false;
  private errorFired = false;
  private readonly sampleRate: number;

  constructor(
    private readonly opts: TtsSessionOptions,
    private readonly cb: TtsSessionCallbacks,
  ) {
    this.sampleRate = opts.sampleRate || TTS_SAMPLE_RATE;
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
      tempDir = await this.createTempDir();
      const mp3Path = join(tempDir, 'reply.mp3');
      await this.synthesize({
        text: this.opts.text,
        outputPath: mp3Path,
        voice: this.opts.voice,
        signal: this.abortController.signal,
        exec: this.opts.exec,
      });
      if (this.closed) return;

      const pcm = await this.convertMp3ToPcm({
        mp3Path,
        sampleRate: this.sampleRate,
        signal: this.abortController.signal,
      });
      if (this.closed) return;

      this.cb.onOpen?.();
      for (let offset = 0; offset < pcm.byteLength && !this.closed; offset += PCM_CHUNK_BYTES) {
        this.cb.onAudio(new Uint8Array(pcm.subarray(offset, offset + PCM_CHUNK_BYTES)));
      }
      if (this.closed) return;
      this.finish();
    } catch {
      if (!this.closed) this.fail('openclaw_infer_tts_failed');
    } finally {
      if (tempDir) await this.cleanupTempDir(tempDir);
    }
  }

  private synthesize(request: {
    text: string;
    outputPath: string;
    voice?: string;
    signal?: AbortSignal;
    exec?: OpenClawInferExec;
  }): Promise<void> {
    return this.opts.synthesize?.(request) ?? synthesizeTtsWithOpenClawInfer(request);
  }

  private convertMp3ToPcm(request: {
    mp3Path: string;
    sampleRate: number;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    return this.opts.convertMp3ToPcm?.(request) ?? convertMp3ToPcm(request);
  }

  private createTempDir(): Promise<string> {
    return this.opts.createTempDir?.() ?? mkdtemp(join(tmpdir(), 'clawkie-openclaw-tts-'));
  }

  private async cleanupTempDir(path: string): Promise<void> {
    try {
      if (this.opts.cleanupTempDir) {
        await this.opts.cleanupTempDir(path);
      } else {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // best effort cleanup
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
    this.abortController.abort();
    this.cb.onError(message);
  }
}

export function convertMp3ToPcm(request: {
  mp3Path: string;
  sampleRate?: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const sampleRate = request.sampleRate ?? TTS_SAMPLE_RATE;
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        request.mp3Path,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        maxBuffer: FFMPEG_MAX_BUFFER_BYTES,
        signal: request.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}
