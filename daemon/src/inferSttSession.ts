import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcm16ToWavBuffer } from './audio.js';
import { transcribeWithOpenClawInfer } from './openclawInfer.js';
import { PhraseChunker, type PhraseChunk } from './phraseChunker.js';
import type { SttSessionCallbacks } from './sttTypes.js';

const DEFAULT_SAMPLE_RATE = 16000;
const PCM16_BYTES_PER_SAMPLE = 2;
const VAD_FRAME_DURATION_MS = 20;
const DEFAULT_PARTIAL_CHUNK_CADENCE_MS = 5_000;
const DEFAULT_PARTIAL_CHUNK_OVERLAP_MS = 500;
const DEFAULT_MAX_CONCURRENT_CHUNK_TRANSCRIPTS = 2;

type TranscribeRequest = {
  wavPath: string;
  language?: string;
  signal?: AbortSignal;
};

type TranscribeFn = (request: TranscribeRequest) => Promise<string>;

type PcmToWavFn = (pcm: Buffer, sampleRate: number) => Buffer;
type WriteFileFn = (path: string, data: Buffer) => Promise<void>;
type CreateTempDirFn = () => Promise<string>;
type CleanupTempDirFn = (path: string) => Promise<void>;
type DetectSpeechFn = (pcm: Buffer) => boolean;
type LogFn = (message: string) => void;

type PartialChunkJob = {
  id: number;
  pcm: Buffer;
  windowStartMs: number;
  windowEndMs: number;
  queuedAtMs: number;
  source: 'cadence' | 'vad';
};

type SpeechDetectorLike = {
  isSpeech: (pcm: Buffer) => boolean;
  destroy?: () => void;
};

type PhraseChunkerLike = {
  push: (pcm: Buffer, isSpeech: boolean) => PhraseChunk[];
  flush: () => PhraseChunk[];
};

export interface OpenClawInferSttSessionOptions {
  sampleRate?: number;
  language?: string;
  transcribe?: TranscribeFn;
  transcribeChunk?: TranscribeFn;
  pcmToWav?: PcmToWavFn;
  writeFile?: WriteFileFn;
  createTempDir?: CreateTempDirFn;
  cleanupTempDir?: CleanupTempDirFn;
  phraseChunker?: PhraseChunkerLike;
  detectSpeech?: DetectSpeechFn;
  speechDetector?: SpeechDetectorLike;
  enablePhraseChunks?: boolean;
  partialChunkCadenceMs?: number;
  partialChunkOverlapMs?: number;
  maxConcurrentChunkTranscripts?: number;
  log?: LogFn;
}

export class OpenClawInferSttSession {
  private readonly chunks: Buffer[] = [];
  private readonly abortController = new AbortController();
  private readonly chunkAbortController = new AbortController();
  private readonly phraseChunker?: PhraseChunkerLike;
  private readonly partialChunkCadenceMs: number;
  private readonly partialChunkOverlapMs: number;
  private readonly maxConcurrentChunkTranscripts: number;
  private closed = false;
  private audioDoneStarted = false;
  private totalPcmBytes = 0;
  private nextCadenceChunkEndMs: number;
  private chunkTranscriptQueue: PartialChunkJob[] = [];
  private activeChunkTranscripts = 0;
  private chunkCounter = 0;
  private speechDetectorDestroyed = false;
  private vadRemainder: Buffer = Buffer.alloc(0);

  constructor(
    private readonly opts: OpenClawInferSttSessionOptions,
    private readonly cb: SttSessionCallbacks,
  ) {
    this.phraseChunker = opts.phraseChunker ?? this.createDefaultPhraseChunker();
    this.partialChunkCadenceMs = opts.partialChunkCadenceMs ?? DEFAULT_PARTIAL_CHUNK_CADENCE_MS;
    this.partialChunkOverlapMs = opts.partialChunkOverlapMs ?? DEFAULT_PARTIAL_CHUNK_OVERLAP_MS;
    this.maxConcurrentChunkTranscripts = Math.max(
      1,
      Math.floor(opts.maxConcurrentChunkTranscripts ?? DEFAULT_MAX_CONCURRENT_CHUNK_TRANSCRIPTS),
    );
    this.nextCadenceChunkEndMs = this.partialChunkCadenceMs;
    this.cb.onReady();
  }

  sendAudio(bytes: Uint8Array): void {
    if (this.closed || this.audioDoneStarted) return;
    const pcm = Buffer.from(bytes);
    this.chunks.push(pcm);
    this.totalPcmBytes += pcm.length;
    this.enqueueDueCadenceChunks();
    this.processVadFrames(pcm);
  }

  async signalAudioDone(): Promise<void> {
    if (this.closed || this.audioDoneStarted) return;
    this.audioDoneStarted = true;
    this.chunkTranscriptQueue = [];
    this.chunkAbortController.abort();

    let tempDir: string | undefined;
    try {
      if (this.phraseChunker) {
        this.flushVadRemainderAsUnvoiced();
        this.phraseChunker.flush();
      }
      if (this.closed) return;

      tempDir = await this.createTempDir();
      const wavPath = join(tempDir, 'turn.wav');
      const pcm = Buffer.concat(this.chunks);
      const wav = this.pcmToWav(pcm, this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
      await this.writeFile(wavPath, wav);

      const finalStartedAtMs = Date.now();
      this.log(`[stt] final infer start wav=turn.wav`);
      const text = await this.transcribe({
        wavPath,
        language: this.opts.language,
        signal: this.abortController.signal,
      });
      this.log(`[stt] final infer done latencyMs=${Date.now() - finalStartedAtMs}`);

      if (this.closed) return;
      this.closed = true;
      this.abortController.abort();
      this.chunkAbortController.abort();
      this.destroySpeechDetector();
      this.cb.onDone(text);
      this.cb.onClosed();
    } catch {
      if (this.closed) return;
      this.closed = true;
      this.abortController.abort();
      this.chunkAbortController.abort();
      this.destroySpeechDetector();
      this.cb.onError('openclaw_infer_stt_failed');
      this.cb.onClosed();
    } finally {
      if (tempDir) await this.cleanupTempDir(tempDir);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.chunkAbortController.abort();
    this.chunkTranscriptQueue = [];
    this.destroySpeechDetector();
  }

  private enqueueDueCadenceChunks(): void {
    if (!this.isPartialChunkingEnabled()) return;
    if (this.partialChunkCadenceMs <= 0) return;

    const receivedMs = this.bytesToMs(this.totalPcmBytes);
    while (receivedMs >= this.nextCadenceChunkEndMs) {
      const windowEndMs = this.nextCadenceChunkEndMs;
      const windowStartMs = Math.max(0, windowEndMs - this.partialChunkCadenceMs - this.partialChunkOverlapMs);
      this.enqueuePartialChunk({
        pcm: this.slicePcmWindow(windowStartMs, windowEndMs),
        windowStartMs,
        windowEndMs,
        source: 'cadence',
      });
      this.nextCadenceChunkEndMs += this.partialChunkCadenceMs;
    }
  }

  private processVadFrames(pcm: Buffer): void {
    const detectSpeech = this.detectSpeechFn();
    if (!this.phraseChunker || !detectSpeech) return;

    const frameByteLength = this.vadFrameByteLength();
    const available = this.vadRemainder.length > 0 ? Buffer.concat([this.vadRemainder, pcm]) : pcm;
    let offset = 0;
    while (offset + frameByteLength <= available.length) {
      const frame = available.subarray(offset, offset + frameByteLength);
      this.pushVadFrame(frame, detectSpeech);
      offset += frameByteLength;
    }
    this.vadRemainder = available.subarray(offset);
  }

  private pushVadFrame(frame: Buffer, detectSpeech: DetectSpeechFn): void {
    let isSpeech = false;
    try {
      isSpeech = detectSpeech(frame);
    } catch {
      // VAD is only used for opportunistic chunk boundaries. Invalid VAD windows
      // or detector failures must not break full-turn buffering/final infer.
      isSpeech = false;
    }

    const completed = this.phraseChunker?.push(frame, isSpeech) ?? [];
    this.enqueueChunkTranscripts(completed);
  }

  private flushVadRemainderAsUnvoiced(): void {
    if (!this.phraseChunker || this.vadRemainder.length === 0) return;
    const completed = this.phraseChunker.push(this.vadRemainder, false);
    this.vadRemainder = Buffer.alloc(0);
    this.enqueueChunkTranscripts(completed);
  }

  private isPartialChunkingEnabled(): boolean {
    return !!this.opts.enablePhraseChunks || !!this.opts.phraseChunker;
  }

  private vadFrameByteLength(): number {
    const sampleRate = this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    return Math.floor((sampleRate * VAD_FRAME_DURATION_MS) / 1000) * PCM16_BYTES_PER_SAMPLE;
  }

  private detectSpeechFn(): DetectSpeechFn | undefined {
    if (this.opts.detectSpeech) return this.opts.detectSpeech;
    const detector = this.opts.speechDetector;
    if (!detector) return undefined;
    return (pcm) => detector.isSpeech(pcm);
  }

  private destroySpeechDetector(): void {
    if (this.speechDetectorDestroyed) return;
    this.speechDetectorDestroyed = true;
    try {
      this.opts.speechDetector?.destroy?.();
    } catch {
      // best effort cleanup
    }
  }

  private enqueueChunkTranscripts(chunks: PhraseChunk[]): void {
    for (const chunk of chunks) {
      const durationMs = chunk.durationMs ?? this.bytesToMs(chunk.pcm.length);
      const windowEndMs = this.bytesToMs(this.totalPcmBytes);
      this.enqueuePartialChunk({
        pcm: chunk.pcm,
        windowStartMs: Math.max(0, windowEndMs - durationMs),
        windowEndMs,
        source: 'vad',
      });
    }
  }

  private enqueuePartialChunk(chunk: Omit<PartialChunkJob, 'id' | 'queuedAtMs'>): void {
    if (this.closed || this.audioDoneStarted) return;
    const job: PartialChunkJob = {
      ...chunk,
      id: ++this.chunkCounter,
      queuedAtMs: Date.now(),
    };
    this.log(
      `[stt] partial chunk id=${job.id} source=${job.source} windowMs=${Math.round(job.windowStartMs)}-${Math.round(
        job.windowEndMs,
      )} queued`,
    );
    this.chunkTranscriptQueue.push(job);
    this.pumpChunkTranscriptQueue();
  }

  private pumpChunkTranscriptQueue(): void {
    if (this.closed || this.audioDoneStarted) {
      this.chunkTranscriptQueue = [];
      return;
    }
    while (
      this.activeChunkTranscripts < this.maxConcurrentChunkTranscripts &&
      this.chunkTranscriptQueue.length > 0 &&
      !this.closed &&
      !this.audioDoneStarted
    ) {
      const job = this.chunkTranscriptQueue.shift();
      if (!job) return;
      this.activeChunkTranscripts += 1;
      void this.transcribePhraseChunk(job).finally(() => {
        this.activeChunkTranscripts -= 1;
        this.pumpChunkTranscriptQueue();
      });
    }
  }

  private async transcribePhraseChunk(job: PartialChunkJob): Promise<void> {
    if (this.closed || this.audioDoneStarted) return;
    let tempDir: string | undefined;
    const startedAtMs = Date.now();
    try {
      tempDir = await this.createTempDir();
      const wavPath = join(tempDir, `chunk-${job.id}.wav`);
      const wav = this.pcmToWav(job.pcm, this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
      await this.writeFile(wavPath, wav);
      this.log(
        `[stt] partial chunk id=${job.id} source=${job.source} windowMs=${Math.round(job.windowStartMs)}-${Math.round(
          job.windowEndMs,
        )} started queueLatencyMs=${startedAtMs - job.queuedAtMs}`,
      );
      const text = await this.transcribeChunk({
        wavPath,
        language: this.opts.language,
        signal: this.chunkAbortController.signal,
      });
      this.log(
        `[stt] partial chunk id=${job.id} source=${job.source} windowMs=${Math.round(job.windowStartMs)}-${Math.round(
          job.windowEndMs,
        )} done latencyMs=${Date.now() - startedAtMs}`,
      );
      if (!this.closed && !this.audioDoneStarted && text) this.cb.onPartial(text, true);
    } catch {
      // Near-live chunks are opportunistic; the full-turn infer remains authoritative.
    } finally {
      if (tempDir) await this.cleanupTempDir(tempDir);
    }
  }

  private slicePcmWindow(startMs: number, endMs: number): Buffer {
    const pcm = Buffer.concat(this.chunks);
    const sampleRate = this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const startByte = Math.max(0, Math.floor((startMs * sampleRate) / 1000) * PCM16_BYTES_PER_SAMPLE);
    const endByte = Math.min(pcm.length, Math.floor((endMs * sampleRate) / 1000) * PCM16_BYTES_PER_SAMPLE);
    return Buffer.from(pcm.subarray(startByte, endByte));
  }

  private bytesToMs(byteLength: number): number {
    return (byteLength / PCM16_BYTES_PER_SAMPLE / (this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE)) * 1000;
  }

  private log(message: string): void {
    if (this.opts.log) {
      this.opts.log(message);
      return;
    }
    if (process.env.NODE_ENV !== 'test') console.error(message);
  }

  private transcribe(request: TranscribeRequest): Promise<string> {
    if (this.opts.transcribe) return this.opts.transcribe(request);
    return transcribeWithOpenClawInfer(request);
  }

  private transcribeChunk(request: TranscribeRequest): Promise<string> {
    if (this.opts.transcribeChunk) return this.opts.transcribeChunk(request);
    return this.transcribe(request);
  }

  private pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    return this.opts.pcmToWav?.(pcm, sampleRate) ?? pcm16ToWavBuffer(pcm, sampleRate);
  }

  private writeFile(path: string, data: Buffer): Promise<void> {
    return this.opts.writeFile?.(path, data) ?? writeFile(path, data);
  }

  private createTempDir(): Promise<string> {
    return this.opts.createTempDir?.() ?? mkdtemp(join(tmpdir(), 'clawkie-openclaw-stt-'));
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

  private createDefaultPhraseChunker(): PhraseChunker | undefined {
    if (!this.opts.enablePhraseChunks) return undefined;
    return new PhraseChunker({ sampleRate: this.opts.sampleRate ?? DEFAULT_SAMPLE_RATE });
  }
}
