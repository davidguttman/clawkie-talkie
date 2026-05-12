import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage, RtcStatus } from '../client/src/rtc/client';
import type { AnalyserScratch, DrivingLoop, DrivingLoopOptions } from '../client/src/voice/drivingLoop';

const root = resolve(__dirname, '..');

let activeMicAnalyser: AnalyserNode | null = null;
let activeHoldMusicAnalyser: AnalyserNode | null = null;
let activeOutputAnalysers: AnalyserNode[] = [];
let holdMusicStartCount = 0;
let holdMusicStopCount = 0;

vi.mock('../client/src/voice/audioSource', async (importActual) => ({
  ...(await importActual<typeof import('../client/src/voice/audioSource')>()),
  getActiveMicAnalyser: () => activeMicAnalyser,
}));

vi.mock('../client/src/voice/tts', () => ({
  getActiveOutputAnalysers: () => activeOutputAnalysers,
  playDaemonTts: vi.fn(() => ({
    analyser: null,
    done: new Promise<void>(() => undefined),
    error: null,
    stop: vi.fn(),
  })),
}));

vi.mock('../client/src/voice/sttDaemon', () => ({
  DaemonNotConnectedError: class DaemonNotConnectedError extends Error {},
  MicPermissionError: class MicPermissionError extends Error {},
  startDaemonSTT: vi.fn(async () => ({
    stop: vi.fn(async () => ''),
    cancel: vi.fn(),
  })),
}));

vi.mock('../client/src/storage', () => ({
  appendTranscriptTurn: vi.fn(),
}));

vi.mock('../client/src/voice/holdMusic', () => ({
  HoldMusicController: class {
    start(): void { holdMusicStartCount += 1; }
    stop(): void { holdMusicStopCount += 1; }
    unlock(): Promise<void> {
      return Promise.resolve();
    }
  },
  getActiveHoldMusicAnalyser: () => activeHoldMusicAnalyser,
  getHoldMusicMuted: () => false,
}));

class FakeAnalyser {
  fftSize = 128;
  frequencyBinCount = 64;
  private frames: Uint8Array[] = [];

  pushFrame(entries: Array<[number, number]>): void {
    const frame = new Uint8Array(this.frequencyBinCount);
    for (const [bin, value] of entries) frame[bin] = value;
    this.frames.push(frame);
  }

  getByteFrequencyData(data: Uint8Array): void {
    const frame = this.frames.shift() ?? new Uint8Array(this.frequencyBinCount);
    data.set(frame);
  }

  getByteTimeDomainData(data: Uint8Array): void {
    data.fill(128);
  }
}

function installMinimalDom(): void {
  const raf = () => 1;
  const caf = () => undefined;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: raf, configurable: true });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: caf, configurable: true });

  if (typeof document !== 'undefined' && document.createElement) return;

  const doc: Document = {
    nodeType: 9,
    defaultView: null,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tagName: string) => ({
      nodeType: 1,
      nodeName: tagName.toUpperCase(),
      tagName: tagName.toUpperCase(),
      ownerDocument: doc,
      style: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      appendChild: () => undefined,
      removeChild: () => undefined,
      insertBefore: () => undefined,
      setAttribute: () => undefined,
    }),
  } as unknown as Document;
  const win = {
    document: doc,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
  };
  Object.defineProperty(doc, 'defaultView', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
}

type FakeDrivingRtc = DrivingLoopOptions['rtc'] & {
  emitControl(msg: ControlMessage): void;
  emitBinary(bytes: Uint8Array): void;
  sentControl: ControlMessage[];
};

function createFakeDrivingRtc(): FakeDrivingRtc {
  const controlListeners = new Set<(msg: ControlMessage) => void>();
  const binaryListeners = new Set<(bytes: ArrayBuffer) => void>();
  const sentControl: ControlMessage[] = [];
  return {
    status: 'open' as RtcStatus,
    hasClient: true,
    sentControl,
    sendControl(msg: ControlMessage): void {
      sentControl.push(msg);
    },
    sendBinary: vi.fn(),
    addControlListener(fn: (msg: ControlMessage) => void): () => void {
      controlListeners.add(fn);
      return () => controlListeners.delete(fn);
    },
    addBinaryListener(fn: (bytes: ArrayBuffer) => void): () => void {
      binaryListeners.add(fn);
      return () => binaryListeners.delete(fn);
    },
    emitControl(msg: ControlMessage): void {
      for (const fn of [...controlListeners]) fn(msg);
    },
    emitBinary(bytes: Uint8Array): void {
      for (const fn of [...binaryListeners]) fn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    },
  };
}

async function renderDrivingLoopHarness(initialOptions: { sessionId?: string; threadId?: string; hostPeerId?: string | null } = {}): Promise<{
  loop(): DrivingLoop;
  rtc: FakeDrivingRtc;
  rerender(options: { sessionId?: string; threadId?: string; hostPeerId?: string | null }): Promise<void>;
  unmount(): Promise<void>;
}> {
  installMinimalDom();
  const { createRoot } = await import('react-dom/client');
  const { useDrivingLoop } = await import('../client/src/voice/drivingLoop');
  const rtc = createFakeDrivingRtc();
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  let currentLoop: DrivingLoop | null = null;
  let currentOptions = {
    sessionId: initialOptions.sessionId ?? 'session-1',
    threadId: initialOptions.threadId ?? 'thread-1',
    hostPeerId: initialOptions.hostPeerId ?? 'host-1',
  };

  function Probe(): null {
    currentLoop = useDrivingLoop({
      ...currentOptions,
      rtc,
    });
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    loop: () => {
      if (!currentLoop) throw new Error('driving loop not rendered');
      return currentLoop;
    },
    rtc,
    rerender: async (options) => {
      currentOptions = {
        sessionId: options.sessionId ?? currentOptions.sessionId,
        threadId: options.threadId ?? currentOptions.threadId,
        hostPeerId: options.hostPeerId ?? currentOptions.hostPeerId,
      };
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activeMicAnalyser = null;
  activeHoldMusicAnalyser = null;
  activeOutputAnalysers = [];
  holdMusicStartCount = 0;
  holdMusicStopCount = 0;
});


describe('driving loop old-daemon compatibility', () => {
  it('consumes old snapshot nested terminal reply/tts events ahead of incomplete snapshot phase', async () => {
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(holdMusicStartCount).toBeGreaterThan(0);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'thinking',
            userText: 'hello?',
          },
          events: [
            { id: 1, msg: { t: 'reply.done', text: 'done already' } },
            { id: 2, msg: { t: 'tts.start', sample_rate: 24000 } },
            { id: 3, msg: { t: 'tts.done' } },
          ],
        });
      });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().liveText).toBe('');
      expect(holdMusicStopCount).toBeGreaterThan(0);
    } finally {
      await rendered.unmount();
    }
  });

  it('treats old snapshot nested tts.done with no active TTS handle as normal completion that stops hold music', async () => {
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(holdMusicStartCount).toBeGreaterThan(0);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'thinking',
            userText: 'waiting turn',
          },
          events: [{ id: 9, msg: { t: 'tts.done' } }],
        });
      });

      expect(holdMusicStopCount).toBeGreaterThan(0);
      expect(rendered.loop().state).toBe('idle');
    } finally {
      await rendered.unmount();
    }
  });

  it('reattaches a completed old-daemon snapshot as idle without synthetic TTS or hold music', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const storageModule = await import('../client/src/storage');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    const appendTranscriptTurn = vi.mocked(storageModule.appendTranscriptTurn);
    const rendered = await renderDrivingLoopHarness({ sessionId: 'completed-session', threadId: 'thread-done' });
    try {
      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'completed',
            userText: 'hello',
            replyText: 'finished reply',
          },
          events: [
            { id: 1, msg: { t: 'reply.done', text: 'finished reply' } },
            { id: 2, msg: { t: 'tts.start', sample_rate: 24000 } },
            { id: 3, msg: { t: 'tts.done' } },
          ],
        });
      });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().liveText).toBe('');
      expect(playDaemonTts).not.toHaveBeenCalled();
      expect(holdMusicStartCount).toBe(0);
      expect(holdMusicStopCount).toBe(0);
      expect(appendTranscriptTurn).toHaveBeenCalledWith(
        { sessionId: 'completed-session', threadId: 'thread-done', hostPeerId: 'host-1' },
        { role: 'assistant', text: 'finished reply' },
      );
    } finally {
      await rendered.unmount();
    }
  });

  it('waits for local live TTS playback completion after wire tts.done', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      stop: vi.fn(),
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      expect(rendered.loop().state).toBe('idle');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'hello' });
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('hello');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'reply.done', text: 'spoken reply' });
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('hello');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000 });
      });
      expect(rendered.loop().state).toBe('ai');
      expect(rendered.loop().liveText).toBe('spoken reply');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.done' });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'spoken reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('feeds snapshot tts.done to the active TTS handle without closing UI before local playback completes', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    const handleControlMessage = vi.fn();
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      handleControlMessage,
      stop: vi.fn(),
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'hello' });
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'reply.done', text: 'spoken reply' });
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000 });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'completed',
            userText: 'hello',
            replyText: 'spoken reply',
          },
          events: [{ msg: { t: 'tts.done' } }],
        });
      });

      expect(handleControlMessage).toHaveBeenCalledWith({ t: 'tts.done' });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'spoken reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('does not overwrite an active TTS handle when a speaking snapshot replays without terminal audio', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    const stop = vi.fn();
    const handleControlMessage = vi.fn();
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      handleControlMessage,
      stop,
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'hello' });
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'reply.done', text: 'spoken reply' });
      });
      expect(playDaemonTts).toHaveBeenCalledTimes(1);

      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000 });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'speaking',
            userText: 'hello',
            replyText: 'spoken reply',
          },
          events: [],
        });
      });

      expect(playDaemonTts).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(handleControlMessage).not.toHaveBeenCalled();
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'spoken reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('feeds snapshot tts.error to the active TTS handle and surfaces one local playback error', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    let handleError: string | undefined;
    const handleControlMessage = vi.fn((msg: { t: string; [k: string]: unknown }) => {
      if (msg.t !== 'tts.error') return;
      handleError = typeof msg.message === 'string' ? msg.message : 'tts_error';
      resolveDone();
    });
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      get error() {
        return handleError;
      },
      handleControlMessage,
      stop: vi.fn(),
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'hello' });
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'reply.done', text: 'spoken reply' });
      });
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000 });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            phase: 'error',
            userText: 'hello',
            replyText: 'spoken reply',
            error: 'snapshot_phase_error',
          },
          events: [{ msg: { t: 'tts.error', message: 'openclaw_infer_tts_failed' } }],
        });
        await Promise.resolve();
      });

      expect(handleControlMessage).toHaveBeenCalledTimes(1);
      expect(handleControlMessage).toHaveBeenCalledWith({ t: 'tts.error', message: 'openclaw_infer_tts_failed' });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().error).toBe('openclaw_infer_tts_failed');
    } finally {
      await rendered.unmount();
    }
  });

  it('arms TTS immediately for daemon-buffered reconnect audio and resets after local playback completion', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      stop: vi.fn(),
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, text: 'missed reply' });
      });

      expect(playDaemonTts).toHaveBeenCalledWith(expect.objectContaining({
        initialControlMessage: { t: 'tts.start', sample_rate: 24000, buffered: true, text: 'missed reply' },
      }));
      expect(rendered.loop().state).toBe('ai');
      expect(rendered.loop().liveText).toBe('missed reply');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.done' });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'missed reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('keeps full buffered reconnect audio attached until local playback drains', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    const playedChunks: Buffer[] = [];
    const observedControls: Array<{ t: string; [k: string]: unknown }> = [];
    let resolveDone!: () => void;
    playDaemonTts.mockImplementationOnce((opts) => {
      opts.addBinaryListener((bytes) => {
        playedChunks.push(Buffer.from(bytes));
      });
      opts.addControlListener((msg) => {
        observedControls.push(msg);
      });
      return {
        analyser: null,
        done: new Promise<void>((resolve) => { resolveDone = resolve; }),
        error: null,
        stop: vi.fn(),
      };
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, turnId: 12, text: 'missed reply' });
      });

      expect(playDaemonTts).toHaveBeenCalledWith(expect.objectContaining({
        initialControlMessage: { t: 'tts.start', sample_rate: 24000, buffered: true, turnId: 12, text: 'missed reply' },
      }));
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.rtc.emitBinary(new Uint8Array([1, 2, 3]));
        rendered.rtc.emitBinary(new Uint8Array([4, 5]));
        rendered.rtc.emitControl({ t: 'tts.done' });
      });

      expect(playedChunks).toEqual([Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
      expect(observedControls).toContainEqual({ t: 'tts.done' });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'missed reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('keeps daemon-buffered replay in AI state after the wire tts.done until local playback drains', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    const analyser = new FakeAnalyser();
    let resolveDone!: () => void;
    const ttsHandle = {
      analyser: analyser as unknown as AnalyserNode,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      stop: vi.fn(),
    };
    playDaemonTts.mockReturnValueOnce(ttsHandle);
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        // Actual missed-replay reconnect ordering can include the live turn's
        // stale done immediately before the daemon drains buffered PCM. The
        // buffered done means "all PCM sent", not "browser playback ended".
        rendered.rtc.emitControl({ t: 'tts.done' });
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, text: 'missed reply' });
        rendered.rtc.emitControl({ t: 'tts.done' });
      });

      expect(playDaemonTts).toHaveBeenCalledWith(expect.objectContaining({
        initialControlMessage: { t: 'tts.start', sample_rate: 24000, buffered: true, text: 'missed reply' },
      }));
      expect(rendered.loop().state).toBe('ai');
      expect(rendered.loop().liveText).toBe('missed reply');

      analyser.pushFrame([[10, 240]]);
      const bands = readTargetBands(rendered.loop().state, [], ttsHandle, new WeakMap<AnalyserNode, AnalyserScratch>());
      expect(Math.max(...bands)).toBeGreaterThan(0.1);

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toEqual({ who: 'ai', text: 'missed reply' });
    } finally {
      await rendered.unmount();
    }
  });

  it('surfaces tts.error promptly without waiting for the local TTS handle', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: 'late_handle_error',
      stop: vi.fn(),
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, text: 'spoken reply' });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.error', message: 'openclaw_infer_tts_failed' });
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().error).toBe('openclaw_infer_tts_failed');

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().error).toBe('openclaw_infer_tts_failed');
    } finally {
      await rendered.unmount();
    }
  });

  it('shows daemon-buffered reconnect audio as active AI playback even without text and lets silence stop it', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    const stop = vi.fn();
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>(() => undefined),
      error: null,
      stop,
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true });
      });

      expect(playDaemonTts).toHaveBeenCalledWith(expect.objectContaining({
        initialControlMessage: { t: 'tts.start', sample_rate: 24000, buffered: true },
      }));
      expect(rendered.loop().state).toBe('ai');
      expect(rendered.loop().liveText).toBe('');

      await act(async () => {
        rendered.loop().silence();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(stop).toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it('lets tap stop active TTS playback through the same local handle', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    const stop = vi.fn();
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>(() => undefined),
      error: null,
      stop,
    });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, text: 'spoken reply' });
      });
      expect(rendered.loop().state).toBe('ai');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(stop).toHaveBeenCalledWith({ cancelRemote: false });
    } finally {
      await rendered.unmount();
    }
  });


  it('resets local TTS/UI state when switching sessions without sending remote reply.cancel or accepting stale completion', async () => {
    const ttsModule = await import('../client/src/voice/tts');
    const playDaemonTts = vi.mocked(ttsModule.playDaemonTts);
    let resolveDone!: () => void;
    const stop = vi.fn((options?: { cancelRemote?: boolean }) => {
      if (options?.cancelRemote !== false) rendered.rtc.sendControl({ t: 'reply.cancel' });
    });
    playDaemonTts.mockReturnValueOnce({
      analyser: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      error: null,
      stop,
    });
    const rendered = await renderDrivingLoopHarness({ sessionId: 'session-a' });
    try {
      await act(async () => {
        rendered.rtc.emitControl({ t: 'tts.start', sample_rate: 24000, buffered: true, text: 'session A reply' });
      });
      expect(rendered.loop().state).toBe('ai');
      expect(rendered.loop().liveText).toBe('session A reply');

      await rendered.rerender({ sessionId: 'session-b' });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().liveText).toBe('');
      expect(rendered.loop().lastTurn).toBeNull();
      expect(stop).toHaveBeenCalledWith({ cancelRemote: false });
      expect(rendered.rtc.sentControl).not.toContainEqual({ t: 'reply.cancel' });

      await act(async () => {
        resolveDone();
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().lastTurn).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

});

describe('driving loop visualization band selection', () => {
  it('mirrors unique low-to-high bands so highs land outside and lows land at the center', async () => {
    const { mirrorCenterOutBands } = await import('../client/src/voice/drivingLoop');

    expect(mirrorCenterOutBands([0.1, 0.25, 0.8])).toEqual([0.8, 0.25, 0.1, 0.1, 0.25, 0.8]);
  });

  it('samples the live mic analyser on every recording tick', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const analyser = new FakeAnalyser();
    activeMicAnalyser = analyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const stalePcmBands = Array(28).fill(0.2);

    analyser.pushFrame([[10, 8]]);
    const first = readTargetBands('recording', stalePcmBands, null, scratch);

    analyser.pushFrame([[10, 56]]);
    const second = readTargetBands('recording', stalePcmBands, null, scratch);

    expect(first).not.toEqual(stalePcmBands);
    expect(second).not.toEqual(stalePcmBands);
    expect(Math.max(...second)).toBeGreaterThan(Math.max(...first) + 0.15);
  });

  it('falls back to the latest PCM bands only when no mic analyser exists', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const fallback = Array.from({ length: 28 }, (_, i) => 0.08 + i * 0.01);

    expect(readTargetBands('recording', fallback, null, scratch)).toBe(fallback);
  });
});

describe('driving loop thinking visualizer source selection', () => {
  it('uses the hold music analyser in thinking when no tts/remote analyser exists', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[50, 255]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();

    const bands = readTargetBands('thinking', [], null, scratch);

    expect(bands).toHaveLength(28);
    expect(bands.slice(0, 14)).toEqual(bands.slice(14).reverse());
    expect(bands[13]).toBe(bands[14]);
    // High-bin signal: highs render on the outside edges, so center sits lower.
    expect(bands[13]).toBeLessThan(bands[0]);
  });

  it('does not include the hold music analyser when state is ai', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[10, 96]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();

    // No tts/remote analyser available either; should fall back to QUIET.
    const bands = readTargetBands('ai', [], null, scratch);
    expect(Math.max(...bands)).toBeLessThan(0.1);
  });

  it('does not affect non-thinking/ai states', async () => {
    const { readTargetBands } = await import('../client/src/voice/drivingLoop');
    const holdAnalyser = new FakeAnalyser();
    holdAnalyser.pushFrame([[10, 200]]);
    activeHoldMusicAnalyser = holdAnalyser as unknown as AnalyserNode;
    const scratch = new WeakMap<AnalyserNode, AnalyserScratch>();
    const fallback = Array.from({ length: 28 }, (_, i) => 0.08 + i * 0.01);

    expect(readTargetBands('idle', fallback, null, scratch)).not.toBe(fallback);
    expect(Math.max(...readTargetBands('idle', fallback, null, scratch))).toBeLessThan(0.1);
  });
});

describe('driving loop hold music state gates', () => {
  it('starts while waiting for the agent and relies on tts.start to stop speech-time music', async () => {
    const { syncHoldMusicForDrivingState } = await import('../client/src/voice/drivingLoop');
    const holdMusic = { start: vi.fn(), stop: vi.fn() };

    syncHoldMusicForDrivingState('thinking', holdMusic);
    // AI state only begins after tts.start now. The control-message gate
    // below is responsible for stopping music at that exact audio boundary.
    syncHoldMusicForDrivingState('ai', holdMusic);

    expect(holdMusic.start).toHaveBeenCalledTimes(1);
    expect(holdMusic.stop).not.toHaveBeenCalled();

    syncHoldMusicForDrivingState('recording', holdMusic);
    syncHoldMusicForDrivingState('idle', holdMusic);

    expect(holdMusic.stop).toHaveBeenCalledTimes(2);
  });

  it('stops when daemon speech starts or the waiting turn ends', async () => {
    const { shouldStopHoldMusicForControlMessage } = await import('../client/src/voice/drivingLoop');

    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.start' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.done' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'tts.error' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'reply.error' })).toBe(true);
    expect(shouldStopHoldMusicForControlMessage({ t: 'reply.done' })).toBe(false);
    expect(shouldStopHoldMusicForControlMessage({ t: 'stt.partial' })).toBe(false);
  });
});


describe('driving loop active STT snapshot reconnect handling', () => {
  it('resolves a pending-start stop when startDaemonSTT rejects after the user tapped stop', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    let rejectStart!: (err: Error) => void;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    startDaemonSTT.mockReturnValueOnce(pendingStart);

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');

      await act(async () => {
        rejectStart(new Error('mic exploded'));
        await pendingStart.catch(() => undefined);
        await Promise.resolve();
      });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().error).toBe('mic exploded');
    } finally {
      await rendered.unmount();
    }
  });

  it('ignores a canceled stale pending-start onError after a newer recording starts', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const starts: Array<{ onError: (reason: string) => void }> = [];
    const firstStart = new Promise<never>(() => undefined);
    const stopSecond = vi.fn(async () => 'fresh words');
    const cancelSecond = vi.fn();
    startDaemonSTT
      .mockImplementationOnce((options) => {
        starts.push(options);
        return firstStart;
      })
      .mockImplementationOnce(async (options) => {
        starts.push(options);
        return { stop: stopSecond, cancel: cancelSecond };
      });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('recording');
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);

      await rendered.rerender({ sessionId: 'session-2' });
      expect(rendered.loop().state).toBe('idle');

      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(startDaemonSTT).toHaveBeenCalledTimes(2);
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        starts[0].onError('stale mic failed');
        await Promise.resolve();
      });

      expect(rendered.loop().state).toBe('recording');
      expect(rendered.loop().error).toBeNull();
      expect(cancelSecond).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it.each(['recording', 'listening', 'stt'] as const)('preserves the local mic handle for an active %s reconnect snapshot', async (phase) => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'captured words');
    const cancel = vi.fn();
    startDaemonSTT.mockResolvedValueOnce({ stop, cancel });
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            turn: {
              phase,
              transcript: 'partial local words',
            },
          },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('recording');
      expect(stop).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  it('preserves a same-tab recording snapshot while the local STT start is still pending', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'captured words');
    const cancel = vi.fn();
    let resolveStart!: (handle: { stop: typeof stop; cancel: typeof cancel }) => void;
    const pendingStart = new Promise<{ stop: typeof stop; cancel: typeof cancel }>((resolve) => {
      resolveStart = resolve;
    });
    startDaemonSTT.mockReturnValueOnce(pendingStart);

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });

      expect(startDaemonSTT).toHaveBeenCalledTimes(1);
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            turn: {
              phase: 'recording',
              transcript: 'partial local words',
            },
          },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('recording');
      expect(stop).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => {
        resolveStart({ stop, cancel });
        await pendingStart;
        await Promise.resolve();
      });

      expect(rendered.loop().state).toBe('recording');
      expect(stop).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => {
        rendered.loop().tap();
      });

      expect(rendered.loop().state).toBe('thinking');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  it('keeps a cold-launch recording snapshot idle so the next tap starts a fresh mic', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            turn: {
              phase: 'recording',
              transcript: 'old partial words',
            },
          },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().liveText).toBe('');
      expect(rendered.loop().lastTurn).toBeNull();
      expect(startDaemonSTT).not.toHaveBeenCalled();

      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(rendered.loop().state).toBe('recording');
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  it('preserves a same-tab recording snapshot while a pending STT start has already been stopped', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'captured words');
    const cancel = vi.fn();
    let resolveStart!: (handle: { stop: typeof stop; cancel: typeof cancel }) => void;
    const pendingStart = new Promise<{ stop: typeof stop; cancel: typeof cancel }>((resolve) => {
      resolveStart = resolve;
    });
    startDaemonSTT.mockReturnValueOnce(pendingStart);

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            turn: {
              phase: 'recording',
              transcript: 'partial local words',
            },
          },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('thinking');
      expect(stop).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => {
        resolveStart({ stop, cancel });
        await pendingStart;
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'captured words' });
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('captured words');
    } finally {
      await rendered.unmount();
    }
  });

  it.each(['recording', 'listening', 'stt'] as const)('preserves a same-tab %s snapshot while STT stop is in flight', async (phase) => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'captured words');
    const cancel = vi.fn();
    startDaemonSTT.mockResolvedValueOnce({ stop, cancel });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: {
            turn: {
              phase,
              transcript: 'partial local words',
            },
          },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('thinking');

      await act(async () => {
        rendered.rtc.emitControl({ t: 'stt.done', text: 'captured words' });
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('captured words');
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it.each([
    { event: { t: 'stt.done' as const, text: 'captured words' }, expectedAfterReplay: 'thinking' as const },
    { event: { t: 'stt.error' as const, message: 'stt crashed' }, expectedAfterReplay: 'idle' as const },
  ])('clears stop-in-flight preservation after replayed $event.t from a session snapshot', async ({ event, expectedAfterReplay }) => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'captured words');
    const cancel = vi.fn();
    startDaemonSTT.mockResolvedValueOnce({ stop, cancel });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');
      expect(stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { turn: { phase: expectedAfterReplay === 'thinking' ? 'thinking' : 'error', transcript: 'captured words' } },
          events: [{ msg: event }],
        });
      });
      expect(rendered.loop().state).toBe(expectedAfterReplay);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { turn: { phase: 'recording', transcript: 'old partial words' } },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('idle');
      expect(rendered.loop().liveText).toBe('');
      expect(rendered.loop().lastTurn).toBeNull();
      expect(rendered.loop().error).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it('cancels a pending local STT start when an idle snapshot catches up before the handle resolves', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const firstStop = vi.fn(async () => 'stale words');
    const firstCancel = vi.fn();
    const secondStop = vi.fn(async () => 'fresh words');
    const secondCancel = vi.fn();
    let resolveFirstStart!: (handle: { stop: typeof firstStop; cancel: typeof firstCancel }) => void;
    const firstStart = new Promise<{ stop: typeof firstStop; cancel: typeof firstCancel }>((resolve) => {
      resolveFirstStart = resolve;
    });
    startDaemonSTT
      .mockReturnValueOnce(firstStart)
      .mockResolvedValueOnce({ stop: secondStop, cancel: secondCancel });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('recording');
      expect(startDaemonSTT).toHaveBeenCalledTimes(1);

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { phase: 'idle' },
          events: [],
        });
      });

      expect(rendered.loop().state).toBe('idle');

      await act(async () => {
        resolveFirstStart({ stop: firstStop, cancel: firstCancel });
        await firstStart;
        await Promise.resolve();
      });

      expect(firstCancel).toHaveBeenCalledTimes(1);
      expect(firstStop).not.toHaveBeenCalled();
      expect(rendered.loop().state).toBe('idle');

      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(rendered.loop().state).toBe('recording');
      expect(startDaemonSTT).toHaveBeenCalledTimes(2);
      expect(secondStop).not.toHaveBeenCalled();
      expect(secondCancel).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it('cancels an active local STT handle before replaying a non-STT snapshot into thinking', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'local words');
    const cancel = vi.fn();
    startDaemonSTT.mockResolvedValueOnce({ stop, cancel });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { phase: 'reply-ready', userText: 'daemon words', pendingReplyText: 'daemon reply' },
          events: [{ msg: { t: 'reply.done', text: 'daemon reply' } }],
        });
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('daemon words');
    } finally {
      await rendered.unmount();
    }
  });

  it('cancels an active local STT handle before replayed stt.done hydrates thinking', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'local words');
    const cancel = vi.fn();
    startDaemonSTT.mockResolvedValueOnce({ stop, cancel });

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(rendered.loop().state).toBe('recording');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { turn: { phase: 'thinking', transcript: 'daemon final words' } },
          events: [{ msg: { t: 'stt.done', text: 'daemon final words' } }],
        });
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('daemon final words');
    } finally {
      await rendered.unmount();
    }
  });

  it('discards a pending stop-in-flight start after replayed stt.done finalizes the turn', async () => {
    const sttModule = await import('../client/src/voice/sttDaemon');
    const startDaemonSTT = vi.mocked(sttModule.startDaemonSTT);
    const stop = vi.fn(async () => 'late local words');
    const cancel = vi.fn();
    let resolveStart!: (handle: { stop: typeof stop; cancel: typeof cancel }) => void;
    const pendingStart = new Promise<{ stop: typeof stop; cancel: typeof cancel }>((resolve) => {
      resolveStart = resolve;
    });
    startDaemonSTT.mockReturnValueOnce(pendingStart);

    const rendered = await renderDrivingLoopHarness();
    try {
      await act(async () => {
        rendered.loop().tap();
      });
      await act(async () => {
        rendered.loop().tap();
      });
      expect(rendered.loop().state).toBe('thinking');

      await act(async () => {
        rendered.rtc.emitControl({
          t: 'session.snapshot',
          snapshot: { turn: { phase: 'thinking', transcript: 'daemon final words' } },
          events: [{ msg: { t: 'stt.done', text: 'daemon final words' } }],
        });
      });

      expect(rendered.loop().state).toBe('thinking');
      expect(rendered.loop().liveText).toBe('daemon final words');

      await act(async () => {
        resolveStart({ stop, cancel });
        await pendingStart;
        await Promise.resolve();
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(rendered.loop().state).toBe('thinking');
    } finally {
      await rendered.unmount();
    }
  });

});

describe('driving loop visualizer frame rendering', () => {
  it('applies a light time-smoothing pass before rendering frames', () => {
    const source = readFileSync(resolve(root, 'client/src/voice/drivingLoop.ts'), 'utf8');

    expect(source).toContain('smoothBandIntensities');
    expect(source).toContain('LIGHT_SMOOTHING');
    expect(source).toContain('attack: 0.85');
    expect(source).toContain('release: 0.6');
    expect(source).not.toContain('renderedBandsRef.current = target;');
    expect(source).not.toContain('setIntensities(target);');
  });
});


describe('driving loop session snapshot reconnect hydration', () => {
  it.each([
    ['thinking', { phase: 'thinking', userText: 'Still working?' }],
    ['speaking', { phase: 'speaking', userText: 'Say hi', replyText: 'Hi there.' }],
  ] as const)('does not synthesize active %s UI from a bare old snapshot without replay events', async (_phase, snapshot) => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot,
    });

    const hydration = plan?.event.hydration;
    expect(hydration?.context.state ?? 'idle').toBe('idle');
    expect(hydration?.context.pendingReplyText ?? '').toBe('');
    expect(hydration?.context.liveReplyText ?? '').toBe('');
    expect(hydration?.armTts ?? false).toBe(false);
  });

  it('does not arm TTS from a bare old reply-ready snapshot without a replayed reply.done event', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'reply-ready',
        userText: 'Are you there?',
        replyText: 'One moment.',
      },
    });

    const hydration = plan?.event.hydration;
    expect(hydration?.armTts ?? false).toBe(false);
    expect(hydration?.context.pendingReplyText ?? '').toBe('');
    expect(hydration?.context.liveReplyText ?? '').toBe('');
  });

  it('still lets replayed terminal events win over active snapshot metadata', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'speaking',
        userText: 'Say hi',
        replyText: 'Hi there.',
      },
      events: [
        { id: 1, msg: { t: 'reply.done', text: 'Hi there.' } },
        { id: 2, msg: { t: 'tts.start', sample_rate: 24000 } },
        { id: 3, msg: { t: 'tts.done' } },
      ],
    });

    expect(plan?.event.events).toEqual([
      { type: 'reply.done', text: 'Hi there.' },
      { type: 'tts.start' },
      { type: 'tts.done' },
    ]);
    expect(plan?.transcript).toEqual({ active: false, sttDone: false, text: '' });
  });

  it('builds an authoritative completed hydration even when missed events are present', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'completed',
        lastUserText: 'What should I do?',
        lastReplyText: 'Pull over safely.',
      },
      events: [
        { t: 'reply.done', text: 'Pull over safely.' },
        { t: 'tts.start', sample_rate: 24000 },
        { t: 'tts.done' },
      ],
    });

    expect(plan).toEqual({
      event: {
        type: 'session.replay',
        events: [
          { type: 'reply.done', text: 'Pull over safely.' },
          { type: 'tts.start' },
          { type: 'tts.done' },
        ],
        hydration: {
          context: {
            state: 'idle',
            lastUserText: 'What should I do?',
            lastReplyText: 'Pull over safely.',
            pendingReplyText: '',
            liveReplyText: '',
            error: null,
          },
          armTts: false,
        },
      },
      transcript: { active: false, sttDone: false, text: '' },
    });
  });

  it('builds reply-ready hydration that can arm TTS for a fresh reconnect', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'reply-ready',
        userText: 'Are you there?',
        replyText: 'One moment.',
      },
      events: [{ t: 'reply.done', text: 'One moment.' }],
    });

    expect(plan?.event).toEqual({
      type: 'session.replay',
      events: [{ type: 'reply.done', text: 'One moment.' }],
      hydration: {
        context: {
          state: 'thinking',
          lastUserText: 'Are you there?',
          lastReplyText: '',
          pendingReplyText: 'One moment.',
          liveReplyText: '',
          error: null,
        },
        armTts: true,
      },
    });
    expect(plan?.transcript).toEqual({ active: true, sttDone: true, text: 'Are you there?' });
  });


  it('hydrates an in-progress speaking snapshot as the active AI reply', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'speaking',
        userText: 'Say hi',
        replyText: 'Hi there.',
      },
      events: [{ t: 'tts.start', sample_rate: 24000 }],
    });

    expect(plan?.event.hydration).toEqual({
      context: {
        state: 'ai',
        lastUserText: 'Say hi',
        lastReplyText: 'Hi there.',
        pendingReplyText: '',
        liveReplyText: 'Hi there.',
        error: null,
      },
      armTts: true,
    });
    expect(plan?.transcript).toEqual({ active: true, sttDone: true, text: 'Say hi' });
  });

  it('hydrates an error snapshot back to idle with the authoritative error text', async () => {
    const { sessionSnapshotReplayPlanFromControlMessage } = await import('../client/src/voice/drivingLoop');

    const plan = sessionSnapshotReplayPlanFromControlMessage({
      t: 'session.snapshot',
      snapshot: {
        phase: 'error',
        userText: 'Try again',
        error: 'reply_failed',
      },
      events: [{ t: 'reply.error', message: 'reply_failed' }],
    });

    expect(plan?.event.hydration).toEqual({
      context: {
        state: 'idle',
        lastUserText: 'Try again',
        lastReplyText: '',
        pendingReplyText: '',
        liveReplyText: '',
        error: 'reply_failed',
      },
      armTts: false,
    });
    expect(plan?.transcript).toEqual({ active: false, sttDone: false, text: '' });
  });
});

describe('driving loop transcript finalization', () => {
  it('routes an empty authoritative final to empty_transcript even when a committed partial exists', async () => {
    const { resolveSttDone } = await import('../client/src/voice/drivingLoop');

    const result = resolveSttDone('   ', ['chunk words']);

    expect(result).toEqual({
      nextAccumulated: [],
      transcript: { active: false, sttDone: false, text: '' },
      event: { type: 'stt.error', reason: 'empty_transcript' },
    });
    expect('saveText' in result).toBe(false);
  });

  it('uses non-empty stt.done text as the saved/dispatch transcript', async () => {
    const { resolveSttDone } = await import('../client/src/voice/drivingLoop');

    const result = resolveSttDone(' authoritative final ', ['chunk words']);

    expect(result).toEqual({
      nextAccumulated: [],
      transcript: { active: true, sttDone: true, text: 'authoritative final' },
      event: { type: 'stt.done', text: 'authoritative final' },
      saveText: 'authoritative final',
    });
  });
});
