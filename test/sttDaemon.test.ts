import { describe, expect, it, vi } from 'vitest';
import {
  MIC_BUFFER_SIZE,
  SAMPLE_RATE,
  type AudioSource,
} from '../client/src/voice/audioSource';
import { PRE_READY_CAP_FRAMES, startDaemonSTT } from '../client/src/voice/sttDaemon';

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
