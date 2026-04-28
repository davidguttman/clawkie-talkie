import createFvadModule, { type FvadWasmModule } from '@echogarden/fvad-wasm';

const DEFAULT_SAMPLE_RATE = 16000;
const PCM16_BYTES_PER_SAMPLE = 2;

export interface WasmVadOptions {
  sampleRate?: number;
  mode?: 0 | 1 | 2 | 3;
}

export interface SpeechDetector {
  isSpeech(pcm: Buffer): boolean;
  destroy(): void;
}

export async function createWasmVad(options: WasmVadOptions = {}): Promise<SpeechDetector> {
  const module = await createFvadModule();
  return new FvadSpeechDetector(module, options.sampleRate ?? DEFAULT_SAMPLE_RATE, options.mode ?? 2);
}

class FvadSpeechDetector implements SpeechDetector {
  private readonly handle: number;
  private destroyed = false;

  constructor(
    private readonly module: FvadWasmModule,
    private readonly sampleRate: number,
    mode: 0 | 1 | 2 | 3,
  ) {
    this.handle = module._fvad_new();
    if (!this.handle) throw new Error('fvad_new_failed');
    if (module._fvad_set_sample_rate(this.handle, sampleRate) !== 0) {
      module._fvad_free(this.handle);
      throw new Error(`fvad_unsupported_sample_rate:${sampleRate}`);
    }
    if (module._fvad_set_mode(this.handle, mode) !== 0) {
      module._fvad_free(this.handle);
      throw new Error(`fvad_unsupported_mode:${mode}`);
    }
  }

  isSpeech(pcm: Buffer): boolean {
    if (this.destroyed) return false;
    const sampleCount = Math.floor(pcm.length / PCM16_BYTES_PER_SAMPLE);
    if (sampleCount === 0) return false;

    const ptr = this.module._malloc(sampleCount * PCM16_BYTES_PER_SAMPLE);
    if (!ptr) throw new Error('fvad_malloc_failed');
    try {
      this.module.HEAP16.set(toInt16Array(pcm, sampleCount), ptr / PCM16_BYTES_PER_SAMPLE);
      const result = this.module._fvad_process(this.handle, ptr, sampleCount);
      if (result < 0) throw new Error(`fvad_process_failed:${result}`);
      return result === 1;
    } finally {
      this.module._free(ptr);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.module._fvad_free(this.handle);
  }
}

function toInt16Array(pcm: Buffer, sampleCount: number): Int16Array {
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = pcm.readInt16LE(i * PCM16_BYTES_PER_SAMPLE);
  return samples;
}
