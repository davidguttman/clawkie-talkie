// Hardware media-control wiring (AirPods play-pause, lock-screen
// transport). Verifies the routing decision, handler installation and
// cleanup, playbackState updates, and the no-API-available fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMediaSessionForTests,
  getMediaSessionDebugSnapshot,
  getMediaSession,
  installMediaSessionControls,
  playbackStateFor,
  shouldStartOrStopOnMediaControl,
} from '../client/src/voice/mediaSession';
import type { DrivingState } from '../client/src/voice/drivingReducer';

class FakeMediaSession {
  handlers: Record<string, (() => void) | null> = {};
  playbackState: 'none' | 'paused' | 'playing' = 'none';
  metadata: unknown = null;
  setActionHandler = vi.fn((action: string, handler: (() => void) | null) => {
    this.handlers[action] = handler;
  });
  setMicrophoneActive = vi.fn();
}

beforeEach(() => {
  _resetMediaSessionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldStartOrStopOnMediaControl', () => {
  it('triggers from idle (start recording) and recording (stop recording)', () => {
    expect(shouldStartOrStopOnMediaControl('idle' as DrivingState)).toBe(true);
    expect(shouldStartOrStopOnMediaControl('recording' as DrivingState)).toBe(true);
  });
  it('is a no-op while thinking or speaking so a stray AirPods press cannot interrupt', () => {
    expect(shouldStartOrStopOnMediaControl('thinking' as DrivingState)).toBe(false);
    expect(shouldStartOrStopOnMediaControl('ai' as DrivingState)).toBe(false);
  });
});

describe('playbackStateFor', () => {
  it('reports paused while idle so the next hardware press fires play', () => {
    expect(playbackStateFor('idle' as DrivingState)).toBe('paused');
  });
  it('reports playing while a turn is active so the next press fires pause', () => {
    expect(playbackStateFor('recording' as DrivingState)).toBe('playing');
    expect(playbackStateFor('thinking' as DrivingState)).toBe('playing');
    expect(playbackStateFor('ai' as DrivingState)).toBe('playing');
  });
});

describe('getMediaSession', () => {
  it('returns null when navigator has no mediaSession', () => {
    vi.stubGlobal('navigator', {});
    expect(getMediaSession()).toBeNull();
  });
  it('returns null when setActionHandler is missing', () => {
    vi.stubGlobal('navigator', { mediaSession: { playbackState: 'none' } });
    expect(getMediaSession()).toBeNull();
  });
  it('returns the mediaSession object when the API is present', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });
    expect(getMediaSession()).toBe(ms);
  });
});

describe('installMediaSessionControls', () => {
  it('is a safe no-op (returns a usable cleanup) when the API is unavailable', () => {
    vi.stubGlobal('navigator', {});
    const onTrigger = vi.fn();
    const cleanup = installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger,
    });
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('registers play/pause/stop/togglemicrophone handlers and publishes playbackState', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });

    installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger: () => {},
    });

    expect(ms.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function));
    expect(ms.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function));
    expect(ms.setActionHandler).toHaveBeenCalledWith('stop', expect.any(Function));
    expect(ms.setActionHandler).toHaveBeenCalledWith('togglemicrophone', expect.any(Function));
    expect(ms.playbackState).toBe('paused');
    expect(getMediaSessionDebugSnapshot()).toMatchObject({
      available: true,
      playbackState: 'paused',
      actionHandlers: {
        play: 'registered',
        pause: 'registered',
        stop: 'registered',
        togglemicrophone: 'registered',
      },
      microphone: {
        available: true,
        desiredActive: false,
        lastSetActive: false,
        status: 'set',
        error: null,
      },
    });
  });

  it('reports playing while recording', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });

    installMediaSessionControls({
      state: 'recording' as DrivingState,
      onTrigger: () => {},
    });

    expect(ms.playbackState).toBe('playing');
    expect(ms.setMicrophoneActive).toHaveBeenCalledWith(true);
    expect(getMediaSessionDebugSnapshot().microphone).toMatchObject({
      available: true,
      desiredActive: true,
      lastSetActive: true,
      status: 'set',
    });
  });

  it('routes a hardware play press to onTrigger when state allows', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });
    const onTrigger = vi.fn();

    installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger,
    });
    ms.handlers.play?.();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(getMediaSessionDebugSnapshot().actions).toMatchObject({
      count: 1,
      last: {
        action: 'play',
        state: 'idle',
        result: 'triggered_ptt',
        triggeredPtt: true,
      },
    });
  });

  it('routes a microphone toggle to onTrigger when state allows', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });
    const onTrigger = vi.fn();

    installMediaSessionControls({
      state: 'recording' as DrivingState,
      onTrigger,
    });
    ms.handlers.togglemicrophone?.();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(getMediaSessionDebugSnapshot().actions.last).toMatchObject({
      action: 'togglemicrophone',
      state: 'recording',
      result: 'triggered_ptt',
      triggeredPtt: true,
    });
  });

  it('drops the action when state is thinking (no surprise mic restart)', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });
    const onTrigger = vi.fn();

    installMediaSessionControls({
      state: 'thinking' as DrivingState,
      onTrigger,
    });
    ms.handlers.play?.();
    ms.handlers.pause?.();
    ms.handlers.stop?.();
    ms.handlers.togglemicrophone?.();

    expect(onTrigger).not.toHaveBeenCalled();
    expect(getMediaSessionDebugSnapshot().actions).toMatchObject({
      count: 4,
      last: {
        action: 'togglemicrophone',
        state: 'thinking',
        result: 'ignored_due_state',
        triggeredPtt: false,
      },
    });
  });

  it('cleanup removes handlers (sets them to null) and clears playbackState', () => {
    const ms = new FakeMediaSession();
    vi.stubGlobal('navigator', { mediaSession: ms });

    const cleanup = installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger: () => {},
    });
    cleanup();

    expect(ms.handlers.play).toBeNull();
    expect(ms.handlers.pause).toBeNull();
    expect(ms.handlers.stop).toBeNull();
    expect(ms.handlers.togglemicrophone).toBeNull();
    expect(ms.playbackState).toBe('none');
    expect(ms.setMicrophoneActive).toHaveBeenLastCalledWith(false);
    expect(getMediaSessionDebugSnapshot().actionHandlers).toEqual({
      play: 'cleared',
      pause: 'cleared',
      stop: 'cleared',
      togglemicrophone: 'cleared',
    });
  });

  it('surfaces setMicrophoneActive errors in the debug snapshot', () => {
    const ms = new FakeMediaSession();
    ms.setMicrophoneActive = vi.fn(() => {
      throw new Error('mic unavailable');
    });
    vi.stubGlobal('navigator', { mediaSession: ms });

    installMediaSessionControls({
      state: 'recording' as DrivingState,
      onTrigger: () => {},
    });

    expect(getMediaSessionDebugSnapshot().microphone).toMatchObject({
      available: true,
      desiredActive: true,
      lastSetActive: null,
      status: 'error',
      error: 'mic unavailable',
    });
  });

  it('keeps going when one setActionHandler call throws (e.g. unsupported action)', () => {
    const ms = new FakeMediaSession();
    let firstCall = true;
    ms.setActionHandler = vi.fn((action: string, handler: (() => void) | null) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('not supported');
      }
      ms.handlers[action] = handler;
    });
    vi.stubGlobal('navigator', { mediaSession: ms });

    expect(() =>
      installMediaSessionControls({
        state: 'idle' as DrivingState,
        onTrigger: () => {},
      }),
    ).not.toThrow();

    // The remaining two handlers still got installed.
    expect(Object.keys(ms.handlers).length).toBeGreaterThanOrEqual(2);
  });

  it('installs MediaMetadata at most once across re-installations', () => {
    const ms = new FakeMediaSession();
    const ctorCalls: Array<{ title: string }> = [];
    class FakeMediaMetadata {
      title: string;
      constructor(init: { title: string }) {
        this.title = init.title;
        ctorCalls.push(init);
      }
    }
    vi.stubGlobal('navigator', { mediaSession: ms });
    vi.stubGlobal('MediaMetadata', FakeMediaMetadata);

    const c1 = installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger: () => {},
    });
    c1();
    const c2 = installMediaSessionControls({
      state: 'idle' as DrivingState,
      onTrigger: () => {},
    });
    c2();

    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0].title).toBe('Clawkie-Talkie');
  });
});
