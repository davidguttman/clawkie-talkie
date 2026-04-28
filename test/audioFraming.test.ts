// Audio framing: Float32 → PCM16LE conversion used when piping mic
// samples into the daemon, and the WAV fixture parser used by the
// deterministic audio source. Regressions here corrupt the bytes we
// ship to daemon STT, which is silent in production but catastrophic —
// so the risky edges get pinned.

import { describe, it, expect } from 'vitest';
import {
  floatTo16BitPcm,
  parseFixture,
} from '../client/src/voice/audioSource';

describe('floatTo16BitPcm', () => {
  it('encodes samples at the int16 extremes', () => {
    const input = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const out = floatTo16BitPcm(input);
    expect(out.byteLength).toBe(input.length * 2);
    const view = new DataView(out);
    expect(view.getInt16(0, true)).toBe(0); // 0
    expect(view.getInt16(2, true)).toBe(0x7fff); // +1 clamped to +32767
    expect(view.getInt16(4, true)).toBe(-0x8000); // -1 clamped to -32768
    // setInt16 truncates (does not round) — pin the exact bytes we ship.
    expect(view.getInt16(6, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(view.getInt16(8, true)).toBe(Math.trunc(-0.5 * 0x8000));
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const input = new Float32Array([1.5, -1.5]);
    const view = new DataView(floatTo16BitPcm(input));
    expect(view.getInt16(0, true)).toBe(0x7fff);
    expect(view.getInt16(2, true)).toBe(-0x8000);
  });

  it('produces little-endian bytes', () => {
    const view = new DataView(floatTo16BitPcm(new Float32Array([-0.25])));
    // -0.25 * 0x8000 = -8192 = 0xE000 in two's complement int16.
    // Little-endian byte order: low byte first.
    expect(view.getUint8(0)).toBe(0x00);
    expect(view.getUint8(1)).toBe(0xe0);
  });
});

describe('parseFixture (WAV)', () => {
  it('passes non-RIFF input through as raw PCM', () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    const out = parseFixture(raw);
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('extracts the data chunk of a minimal PCM16 WAV', () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const wav = buildMinimalWav(payload);
    const out = parseFixture(wav);
    expect(new Uint8Array(out)).toEqual(payload);
  });

  it('throws when a RIFF/WAVE container has no data chunk', () => {
    // RIFF header + WAVE tag but only a `fmt ` chunk, no `data`.
    const header = new Uint8Array(20);
    header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    new DataView(header.buffer).setUint32(4, 12, true); // size
    header.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    header.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt (space)
    new DataView(header.buffer).setUint32(16, 0, true); // fmt size
    expect(() => parseFixture(header.buffer)).toThrow(/no_data_chunk_in_wav/);
  });
});

function buildMinimalWav(pcm: Uint8Array): ArrayBuffer {
  // RIFF/WAVE with one dummy `fmt ` chunk and one `data` chunk.
  const fmtSize = 16;
  const totalSize = 4 + (8 + fmtSize) + (8 + pcm.byteLength);
  const buf = new ArrayBuffer(8 + totalSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, totalSize, true); // RIFF size
  u8.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  u8.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, fmtSize, true); // fmt chunk size
  // Fill fmt chunk with zeros — parseFixture skips it by size.
  u8.set([0x64, 0x61, 0x74, 0x61], 20 + fmtSize); // "data"
  view.setUint32(24 + fmtSize, pcm.byteLength, true); // data chunk size
  u8.set(pcm, 28 + fmtSize);
  return buf;
}
