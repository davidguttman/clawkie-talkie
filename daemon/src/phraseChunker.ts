const DEFAULT_SAMPLE_RATE = 16000;
const PCM16_BYTES_PER_SAMPLE = 2;

type TimedFrame = {
  pcm: Buffer;
  durationMs: number;
};

export type PhraseChunk = {
  pcm: Buffer;
  durationMs: number;
};

export interface PhraseChunkerOptions {
  sampleRate?: number;
  frameDurationMs?: number;
  speechStartMs?: number;
  silenceEndMs?: number;
  preRollMs?: number;
  maxChunkMs?: number;
}

export class PhraseChunker {
  private readonly sampleRate: number;
  private readonly frameDurationMs?: number;
  private readonly speechStartMs: number;
  private readonly silenceEndMs: number;
  private readonly preRollMs: number;
  private readonly maxChunkMs: number;

  private preRoll: TimedFrame[] = [];
  private candidate: TimedFrame[] = [];
  private active: TimedFrame[] = [];
  private candidateSpeechMs = 0;
  private activeMs = 0;
  private silenceMs = 0;

  constructor(opts: PhraseChunkerOptions = {}) {
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.frameDurationMs = opts.frameDurationMs;
    this.speechStartMs = opts.speechStartMs ?? 200;
    this.silenceEndMs = opts.silenceEndMs ?? 700;
    this.preRollMs = opts.preRollMs ?? 250;
    this.maxChunkMs = opts.maxChunkMs ?? 10_000;
  }

  push(bytes: Uint8Array, isSpeech: boolean): PhraseChunk[] {
    const frame = this.makeFrame(bytes);

    if (this.active.length > 0) {
      this.active.push(frame);
      this.activeMs += frame.durationMs;
      this.silenceMs = isSpeech ? 0 : this.silenceMs + frame.durationMs;

      if (this.shouldEndActiveChunk()) return [this.finishActiveChunk()];
      return [];
    }

    if (isSpeech) {
      this.candidate.push(frame);
      this.candidateSpeechMs += frame.durationMs;
      if (this.candidateSpeechMs >= this.speechStartMs) {
        this.active = [...this.preRoll, ...this.candidate];
        this.activeMs = this.sumDuration(this.active);
        this.preRoll = [];
        this.candidate = [];
        this.candidateSpeechMs = 0;
        this.silenceMs = 0;
      }
      return [];
    }

    if (this.candidate.length > 0) {
      this.pushPreRoll(...this.candidate, frame);
      this.candidate = [];
      this.candidateSpeechMs = 0;
      return [];
    }

    this.pushPreRoll(frame);
    return [];
  }

  flush(): PhraseChunk[] {
    if (this.active.length > 0) return [this.finishActiveChunk()];
    this.candidate = [];
    this.candidateSpeechMs = 0;
    return [];
  }

  private shouldEndActiveChunk(): boolean {
    if (this.silenceMs >= this.silenceEndMs) return true;
    return this.activeMs >= this.maxChunkMs && this.silenceMs > 0;
  }

  private finishActiveChunk(): PhraseChunk {
    const frames = this.active;
    const chunk = {
      pcm: Buffer.concat(frames.map((frame) => frame.pcm)),
      durationMs: this.sumDuration(frames),
    };
    this.active = [];
    this.activeMs = 0;
    this.silenceMs = 0;
    this.preRoll = [];
    return chunk;
  }

  private makeFrame(bytes: Uint8Array): TimedFrame {
    const pcm = Buffer.from(bytes);
    const durationMs = this.frameDurationMs ?? (pcm.length / PCM16_BYTES_PER_SAMPLE / this.sampleRate) * 1000;
    return { pcm, durationMs };
  }

  private pushPreRoll(...frames: TimedFrame[]): void {
    this.preRoll.push(...frames);
    while (this.sumDuration(this.preRoll) > this.preRollMs && this.preRoll.length > 0) {
      this.preRoll.shift();
    }
  }

  private sumDuration(frames: TimedFrame[]): number {
    return frames.reduce((sum, frame) => sum + frame.durationMs, 0);
  }
}
