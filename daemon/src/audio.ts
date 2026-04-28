// PCM audio helpers shared between the TTS feed and any future
// daemon-side audio paths. Mirrors the Rambly CLI's audio module so we
// produce the exact frame shape RTCAudioSource expects: 48 kHz mono,
// 480-sample (10 ms) Int16 frames.

export const WEBRTC_SAMPLE_RATE = 48000;
export const FRAME_10MS = 480;

const WAV_HEADER_BYTES = 44;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

// Linear-interpolation resampler over PCM16LE byte buffers. Suitable
// for upsampling 24 kHz xAI TTS to 48 kHz WebRTC media.
export function resamplePcm(
  input: Buffer,
  inputSampleRate: number,
  outputSampleRate: number,
): Buffer {
  if (inputSampleRate === outputSampleRate) return input;

  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);

  const ratio = inputSampleRate / outputSampleRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(s1Index * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

export function pcm16ToWavBuffer(pcm: Buffer, sampleRate: number): Buffer {
  const wav = Buffer.alloc(WAV_HEADER_BYTES + pcm.length);
  const byteRate = sampleRate * 2;
  const blockAlign = 2;

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');

  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // PCM fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM audio format
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);

  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, WAV_HEADER_BYTES);

  return wav;
}

// Slice a PCM16LE buffer into fixed-size Int16 frames. The final
// partial frame (if any) is zero-padded so callers can hand it to
// RTCAudioSource.onData unchanged.
export function pcmToFrames(pcm: Buffer, frameSize: number = FRAME_10MS): Int16Array[] {
  const totalSamples = Math.floor(pcm.length / 2);
  const frames: Int16Array[] = [];

  for (let offset = 0; offset < totalSamples; offset += frameSize) {
    const count = Math.min(frameSize, totalSamples - offset);
    const frame = new Int16Array(frameSize);
    for (let i = 0; i < count; i++) {
      frame[i] = pcm.readInt16LE((offset + i) * 2);
    }
    frames.push(frame);
  }

  return frames;
}
