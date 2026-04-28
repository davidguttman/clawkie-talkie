import { describe, expect, it } from 'vitest';
import { PhraseChunker } from '../daemon/src/phraseChunker';

function frame(value: number): Buffer {
  return Buffer.from([value]);
}

function pushPattern(chunker: PhraseChunker, pattern: Array<[number, boolean]>) {
  return pattern.flatMap(([value, speech]) => chunker.push(frame(value), speech));
}

function bytes(chunks: Array<{ pcm: Buffer }>): number[][] {
  return chunks.map((chunk) => [...chunk.pcm]);
}

function testChunker(options: Partial<ConstructorParameters<typeof PhraseChunker>[0]> = {}) {
  return new PhraseChunker({
    frameDurationMs: 100,
    speechStartMs: 200,
    silenceEndMs: 700,
    preRollMs: 200,
    maxChunkMs: 5000,
    ...options,
  });
}

describe('PhraseChunker', () => {
  it('does not start a chunk for a one-frame speech spike', () => {
    const chunker = testChunker();

    const emitted = pushPattern(chunker, [
      [1, false],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
      [6, false],
      [7, false],
      [8, false],
      [9, false],
      [10, false],
    ]);

    expect(emitted).toEqual([]);
    expect(chunker.flush()).toEqual([]);
  });

  it('starts only after sustained speech satisfies hysteresis', () => {
    const chunker = testChunker();

    const first = chunker.push(frame(1), true);
    const second = chunker.push(frame(2), true);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(bytes(chunker.flush())).toEqual([[1, 2]]);
  });

  it('does not split on a short pause under the silence threshold', () => {
    const chunker = testChunker();

    const emitted = pushPattern(chunker, [
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, true],
      [6, true],
      [7, false],
      [8, false],
      [9, false],
      [10, false],
      [11, false],
      [12, false],
      [13, false],
    ]);

    expect(bytes(emitted)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]]);
  });

  it('ends a chunk after 700ms of silence', () => {
    const chunker = testChunker();

    const emitted = pushPattern(chunker, [
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
      [6, false],
      [7, false],
      [8, false],
    ]);
    expect(emitted).toEqual([]);

    const ended = chunker.push(frame(9), false);
    expect(bytes(ended)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  });

  it('includes pre-roll and post-roll frames in completed chunks', () => {
    const chunker = testChunker({ preRollMs: 300, silenceEndMs: 300 });

    const emitted = pushPattern(chunker, [
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, true],
      [6, false],
      [7, false],
      [8, false],
    ]);

    expect(bytes(emitted)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
  });

  it('waits for silence before cutting an overlong chunk when possible', () => {
    const chunker = testChunker({ maxChunkMs: 500, silenceEndMs: 700 });

    const duringSpeech = pushPattern(chunker, [
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
      [6, true],
    ]);
    expect(duringSpeech).toEqual([]);

    const afterSafeCut = chunker.push(frame(7), false);
    expect(bytes(afterSafeCut)).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
  });
});
