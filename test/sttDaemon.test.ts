import { describe, expect, it, vi } from 'vitest';
import {
  MIC_BUFFER_SIZE,
  SAMPLE_RATE,
  type AudioSource,
} from '../client/src/voice/audioSource';
import {
  PRE_READY_CAP_FRAMES,
  parseSttChunkMs,
  startDaemonSTT,
} from '../client/src/voice/sttDaemon';

describe('startDaemonSTT mic framing', () => {
  it('keeps the pre-ready cap aligned to about one second of mic frames', () => {
    const frameDurationMs = (MIC_BUFFER_SIZE / SAMPLE_RATE) * 1000;

    expect(MIC_BUFFER_SIZE).toBe(1024);
    expect(frameDurationMs).toBe(64);
    expect(PRE_READY_CAP_FRAMES).toBe(16);
    expect(PRE_READY_CAP_FRAMES * frameDurationMs).toBeGreaterThanOrEqual(1000);
    expect(PRE_READY_CAP_FRAMES * frameDurationMs).toBeLessThan(1100);
  });

  it('flushes only the most recent capped pre-ready mic frames after stt.ready', async () => {
    let controlListener: (msg: { t: string; [k: string]: unknown }) => void = () => {};
    const frames = Array.from({ length: PRE_READY_CAP_FRAMES + 4 }, (_, i) => {
      return new Uint8Array([i]).buffer;
    });
    const audioSource: AudioSource = {
      kind: 'mic',
      async start(onFrame) {
        for (const frame of frames) onFrame(frame);
      },
      async stop() {},
    };
    const sendBinary = vi.fn();
    const sendControl = vi.fn((msg: { t: string }) => {
      if (msg.t === 'stt.start') controlListener({ t: 'stt.ready' });
    });

    const handle = await startDaemonSTT({
      sendControl,
      sendBinary,
      addControlListener(fn) {
        controlListener = fn;
        return vi.fn();
      },
      isConnected: () => true,
      audioSource,
    });

    expect(sendBinary).toHaveBeenCalledTimes(PRE_READY_CAP_FRAMES);
    expect(sendBinary.mock.calls.map(([frame]) => new Uint8Array(frame as ArrayBuffer)[0]))
      .toEqual(frames.slice(4).map((frame) => new Uint8Array(frame)[0]));

    controlListener({ t: 'stt.done', text: '' });
    await expect(handle.stop()).resolves.toBe('');
  });
});

describe('parseSttChunkMs', () => {
  it('accepts non-negative integer values', () => {
    expect(parseSttChunkMs('1000')).toEqual({ chunkMs: 1000, chunkBytes: 32000 });
    expect(parseSttChunkMs('64')).toEqual({ chunkMs: 64, chunkBytes: 2048 });
    expect(parseSttChunkMs('3000')).toEqual({ chunkMs: 3000, chunkBytes: 96000 });
    expect(parseSttChunkMs('63')).toEqual({ chunkMs: 63, chunkBytes: 2016 });
    expect(parseSttChunkMs('3001')).toEqual({ chunkMs: 3001, chunkBytes: 96032 });
  });

  it('ignores missing and malformed values', () => {
    expect(parseSttChunkMs(null)).toBeNull();
    expect(parseSttChunkMs(undefined)).toBeNull();
    expect(parseSttChunkMs('')).toBeNull();
    expect(parseSttChunkMs('abc')).toBeNull();
    expect(parseSttChunkMs('1000ms')).toBeNull();
    expect(parseSttChunkMs('-500')).toBeNull();
    expect(parseSttChunkMs('1.5')).toBeNull();
  });
});

describe('startDaemonSTT chunk batching', () => {
  function makePostReadySource(): {
    source: AudioSource;
    emit: (frame: ArrayBuffer) => void;
  } {
    let captured: ((pcm: ArrayBuffer) => void) | null = null;
    return {
      emit(frame) {
        captured?.(frame);
      },
      source: {
        kind: 'fixture',
        async start(onFrame) {
          captured = onFrame;
        },
        async stop() {
          captured = null;
        },
      },
    };
  }

  function harness(chunkConfig: { chunkMs: number; chunkBytes: number } | null) {
    const { source, emit } = makePostReadySource();
    let controlListener: (msg: { t: string; [k: string]: unknown }) => void = () => {};
    const sendBinary = vi.fn();
    const sentControl: { t: string }[] = [];
    const sendControl = vi.fn((msg: { t: string }) => {
      sentControl.push(msg);
      if (msg.t === 'stt.start') controlListener({ t: 'stt.ready' });
    });
    const startedPromise = startDaemonSTT({
      sendControl,
      sendBinary,
      addControlListener(fn) {
        controlListener = fn;
        return vi.fn();
      },
      isConnected: () => true,
      audioSource: source,
      chunkConfig,
    });
    return {
      startedPromise,
      sendBinary,
      sendControl,
      sentControl,
      emit,
      fireControl: (m: { t: string; [k: string]: unknown }) => controlListener(m),
    };
  }

  it('batches ~16 mic frames into one send when sttChunkMs=1000', async () => {
    const h = harness({ chunkMs: 1000, chunkBytes: 32000 });
    const handle = await h.startedPromise;

    for (let i = 0; i < 16; i++) h.emit(new ArrayBuffer(2048));

    expect(h.sendBinary).toHaveBeenCalledTimes(1);
    const sent = h.sendBinary.mock.calls[0][0] as Uint8Array;
    expect(sent.byteLength).toBe(16 * 2048);

    h.fireControl({ t: 'stt.done', text: '' });
    await handle.stop();
  });

  it('flushes a short final partial batch before stt.audio.done on stop()', async () => {
    const h = harness({ chunkMs: 1000, chunkBytes: 32000 });
    const handle = await h.startedPromise;

    for (let i = 0; i < 4; i++) h.emit(new ArrayBuffer(2048));
    expect(h.sendBinary).not.toHaveBeenCalled();

    h.fireControl({ t: 'stt.done', text: 'ok' });
    await handle.stop();

    expect(h.sendBinary).toHaveBeenCalledTimes(1);
    expect((h.sendBinary.mock.calls[0][0] as Uint8Array).byteLength).toBe(4 * 2048);

    const flushIndex = h.sendBinary.mock.invocationCallOrder[0];
    const audioDoneCall = h.sendControl.mock.calls.find((c) => (c[0] as { t: string }).t === 'stt.audio.done');
    expect(audioDoneCall).toBeDefined();
    const audioDoneIndex = h.sendControl.mock.invocationCallOrder[
      h.sendControl.mock.calls.findIndex((c) => (c[0] as { t: string }).t === 'stt.audio.done')
    ];
    expect(flushIndex).toBeLessThan(audioDoneIndex);
  });

  it('discards pending batch on cancel()', async () => {
    const h = harness({ chunkMs: 1000, chunkBytes: 32000 });
    const handle = await h.startedPromise;

    for (let i = 0; i < 4; i++) h.emit(new ArrayBuffer(2048));
    handle.cancel();
    // Settle the now-rejected finalTranscript so the rejection is observed.
    await handle.stop().catch(() => {});

    expect(h.sendBinary).not.toHaveBeenCalled();
  });

  it('default behavior (no chunk config) sends one binary per PCM frame', async () => {
    const h = harness(null);
    const handle = await h.startedPromise;

    for (let i = 0; i < 5; i++) h.emit(new ArrayBuffer(2048));

    expect(h.sendBinary).toHaveBeenCalledTimes(5);

    h.fireControl({ t: 'stt.done', text: '' });
    await handle.stop();
  });
});
