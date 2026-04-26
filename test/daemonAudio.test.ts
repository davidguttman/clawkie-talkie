// Pin the resampler/framing math the daemon uses to feed
// RTCAudioSource. RTCAudioSource demands exactly 480-sample (10 ms)
// Int16 frames at 48 kHz — get the byte count or sample count wrong
// and the wrtc native side will throw or silently drop frames.

import { describe, expect, it } from 'vitest';
import {
  FRAME_10MS,
  WEBRTC_SAMPLE_RATE,
  pcmToFrames,
  resamplePcm,
} from '../daemon/src/audio';

describe('resamplePcm', () => {
  it('passes through when input and output rates match', () => {
    const input = Buffer.from([0x10, 0x00, 0x20, 0x00]); // two int16 samples
    const out = resamplePcm(input, 48000, 48000);
    expect(out.equals(input)).toBe(true);
  });

  it('upsamples 24 kHz → 48 kHz to twice the sample count', () => {
    // 5 input samples → 10 output samples.
    const input = Buffer.alloc(5 * 2);
    for (let i = 0; i < 5; i++) input.writeInt16LE(i * 100, i * 2);
    const out = resamplePcm(input, 24000, 48000);
    expect(out.length / 2).toBe(10);
  });

  it('returns an empty buffer when given empty input', () => {
    expect(resamplePcm(Buffer.alloc(0), 24000, 48000).length).toBe(0);
  });
});

describe('pcmToFrames', () => {
  it('emits 480-sample 48 kHz frames sized for RTCAudioSource', () => {
    const pcm = Buffer.alloc(FRAME_10MS * 2 * 3); // 3 frames
    const frames = pcmToFrames(pcm, FRAME_10MS);
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(f).toBeInstanceOf(Int16Array);
      expect(f.length).toBe(FRAME_10MS);
    }
  });

  it('zero-pads a partial trailing frame so callers can still hand it to onData', () => {
    const partialSamples = 200;
    const pcm = Buffer.alloc(partialSamples * 2);
    for (let i = 0; i < partialSamples; i++) pcm.writeInt16LE(0x4242, i * 2);
    const frames = pcmToFrames(pcm, FRAME_10MS);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.length).toBe(FRAME_10MS);
    for (let i = 0; i < partialSamples; i++) expect(frame[i]).toBe(0x4242);
    for (let i = partialSamples; i < FRAME_10MS; i++) expect(frame[i]).toBe(0);
  });

  it('reports the WebRTC sample rate constants the daemon uses', () => {
    expect(WEBRTC_SAMPLE_RATE).toBe(48000);
    expect(FRAME_10MS).toBe(480);
  });
});
