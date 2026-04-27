// Silent media-session keeper. The keeper is what makes mobile
// browsers consider the page to have an active media session, which
// is what lets `navigator.mediaSession` action handlers (the AirPods
// pinch / lock-screen play-pause) reach the page while idle. These
// tests pin the lifecycle the runtime depends on; actual mobile
// behavior needs device verification.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudioElement {
  src = '';
  currentSrc = '';
  currentTime = 0;
  readyState = 0;
  loop = false;
  autoplay = false;
  preload = '';
  muted = true;
  controls = false;
  volume = 1;
  paused = true;
  attributes: Record<string, string> = {};
  style: Record<string, string> & { cssText: string } = { cssText: '' };
  parent: FakeBody | null = null;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removed = false;
  listeners: Record<string, Array<() => void>> = {};
  // Toggle to make play() return a rejecting promise (autoplay block).
  shouldRejectPlay = false;

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
    delete this.attributes[name];
  }
  get parentNode() {
    return this.parent;
  }
  get nextSibling() {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return index >= 0 ? this.parent.children[index + 1] ?? null : null;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  dispatch(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    this.dispatch('play');
    if (this.shouldRejectPlay) return Promise.reject(new Error('autoplay-blocked'));
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatch('pause');
  }
  load() {
    this.loadCalls += 1;
  }
  remove() {
    this.removed = true;
    if (this.parent) this.parent.removeChild(this);
  }
}

class FakeBody {
  children: FakeAudioElement[] = [];
  appendChild(el: FakeAudioElement) {
    if (el.parent) el.parent.removeChild(el);
    el.parent = this;
    this.children.push(el);
  }
  insertBefore(el: FakeAudioElement, before: FakeAudioElement | null) {
    if (el.parent) el.parent.removeChild(el);
    el.parent = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, el);
    else this.children.push(el);
  }
  removeChild(el: FakeAudioElement) {
    this.children = this.children.filter((c) => c !== el);
    if (el.parent === this) el.parent = null;
  }
}

class FakeDocument {
  body = new FakeBody();
  created: FakeAudioElement[] = [];
  createElement(tag: string): FakeAudioElement {
    if (tag !== 'audio') throw new Error(`unexpected tag ${tag}`);
    const el = new FakeAudioElement();
    this.created.push(el);
    return el;
  }
}

beforeEach(async () => {
  const { _resetMediaSessionKeeperForTests } = await import(
    '../client/src/voice/mediaSessionKeeper'
  );
  _resetMediaSessionKeeperForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('buildSilentWavDataUrl', () => {
  it('produces a base64 data:audio/wav URL with a RIFF/WAVE header decoded back to zero samples', async () => {
    const { buildSilentWavDataUrl } = await import('../client/src/voice/mediaSessionKeeper');
    const url = buildSilentWavDataUrl(0.1, 8000);
    expect(url.startsWith('data:audio/wav;base64,')).toBe(true);
    const b64 = url.slice('data:audio/wav;base64,'.length);
    const bytes = Buffer.from(b64, 'base64');
    expect(bytes.length).toBe(44 + 0.1 * 8000 * 2);
    expect(bytes.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.slice(8, 12).toString('ascii')).toBe('WAVE');
    // Every sample byte must be 0 (silence).
    for (let i = 44; i < bytes.length; i++) {
      expect(bytes[i]).toBe(0);
    }
  });
});

describe('startMediaSessionKeeper', () => {
  it('is a no-op when the DOM is unavailable', async () => {
    // No global document — make sure the import-time code doesn't reach for it.
    const { startMediaSessionKeeper, isMediaSessionKeeperActive } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );
    expect(() => startMediaSessionKeeper()).not.toThrow();
    expect(isMediaSessionKeeperActive()).toBe(false);
  });

  it('creates one hidden, looping, non-muted audio element on the first call', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const {
      getMediaSessionKeeperDebugSnapshot,
      startMediaSessionKeeper,
      isMediaSessionKeeperActive,
    } = await import('../client/src/voice/mediaSessionKeeper');

    startMediaSessionKeeper();

    expect(doc.created).toHaveLength(1);
    expect(doc.body.children).toHaveLength(1);
    const el = doc.created[0];
    expect(el.loop).toBe(true);
    expect(el.autoplay).toBe(true);
    expect(el.muted).toBe(false);
    expect(el.attributes['playsinline']).toBe('true');
    expect(el.attributes['aria-hidden']).toBe('true');
    expect(el.style.position).toBe('absolute');
    expect(el.src.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(el.playCalls).toBe(1);
    expect(isMediaSessionKeeperActive()).toBe(true);
    expect(getMediaSessionKeeperDebugSnapshot()).toMatchObject({
      present: true,
      paused: false,
      readyState: 0,
      events: {
        playCount: 1,
        pauseCount: 0,
        last: {
          type: 'play',
        },
      },
    });
  });

  it('records keeper play/pause events for debug inspection', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const { getMediaSessionKeeperDebugSnapshot, startMediaSessionKeeper } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );

    startMediaSessionKeeper();
    const el = doc.created[0];
    el.pause();
    void el.play();

    expect(getMediaSessionKeeperDebugSnapshot().events).toMatchObject({
      playCount: 2,
      pauseCount: 1,
      last: {
        type: 'play',
      },
    });
  });

  it('can temporarily mount the real keeper element into a debug host with controls', async () => {
    const doc = new FakeDocument();
    const host = new FakeBody();
    vi.stubGlobal('document', doc);

    const { attachMediaSessionKeeperDebugHost, startMediaSessionKeeper } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );

    startMediaSessionKeeper();
    const el = doc.created[0];
    const detach = attachMediaSessionKeeperDebugHost(host as unknown as HTMLElement);

    expect(host.children).toEqual([el]);
    expect(doc.body.children).toHaveLength(0);
    expect(el.controls).toBe(true);
    expect(el.attributes['aria-hidden']).toBe('false');
    expect(el.style.position).toBe('static');
    expect(el.style.opacity).toBe('1');

    detach();

    expect(doc.body.children).toEqual([el]);
    expect(host.children).toHaveLength(0);
    expect(el.controls).toBe(false);
    expect(el.attributes['aria-hidden']).toBe('true');
  });

  it('is idempotent: a second start re-pokes play() but does not create a second element', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const { startMediaSessionKeeper } = await import('../client/src/voice/mediaSessionKeeper');

    startMediaSessionKeeper();
    startMediaSessionKeeper();
    startMediaSessionKeeper();

    expect(doc.created).toHaveLength(1);
    expect(doc.created[0].playCalls).toBe(3);
  });

  it('treats a rejected play() promise as non-fatal', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const { startMediaSessionKeeper, isMediaSessionKeeperActive } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );

    // Patch the very next createElement to return an element that
    // rejects play(). Done by intercepting createElement.
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      const el = origCreate(tag);
      el.shouldRejectPlay = true;
      return el;
    }) as typeof doc.createElement;

    expect(() => startMediaSessionKeeper()).not.toThrow();
    // The element is still attached — iOS may grant playback on a
    // later gesture re-poke.
    expect(isMediaSessionKeeperActive()).toBe(true);
    expect(doc.body.children).toHaveLength(1);
    // Let the rejected promise settle so the test reporter doesn't
    // surface it as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('stopMediaSessionKeeper', () => {
  it('pauses, clears src, and removes the element from the DOM', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const {
      getMediaSessionKeeperDebugSnapshot,
      startMediaSessionKeeper,
      stopMediaSessionKeeper,
      isMediaSessionKeeperActive,
    } = await import('../client/src/voice/mediaSessionKeeper');

    startMediaSessionKeeper();
    const el = doc.created[0];
    stopMediaSessionKeeper();

    expect(el.pauseCalls).toBe(1);
    expect(el.src).toBe('');
    expect(el.removed).toBe(true);
    expect(doc.body.children).toHaveLength(0);
    expect(isMediaSessionKeeperActive()).toBe(false);
    expect(getMediaSessionKeeperDebugSnapshot().events).toMatchObject({
      playCount: 1,
      pauseCount: 1,
      last: {
        type: 'pause',
      },
    });
  });

  it('is a safe no-op when the keeper was never started', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const { stopMediaSessionKeeper } = await import('../client/src/voice/mediaSessionKeeper');
    expect(() => stopMediaSessionKeeper()).not.toThrow();
  });

  it('a fresh start after stop creates a new element', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);

    const { startMediaSessionKeeper, stopMediaSessionKeeper } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );

    startMediaSessionKeeper();
    stopMediaSessionKeeper();
    startMediaSessionKeeper();

    expect(doc.created).toHaveLength(2);
    expect(doc.body.children).toHaveLength(1);
  });
});

describe('unlockDaemonTtsAudio integration', () => {
  it('starts the keeper as part of the trusted gesture path', async () => {
    // Provide both document and a minimal window (no AudioContext is
    // fine; unlockDaemonTtsAudio falls back gracefully).
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {});

    const { unlockDaemonTtsAudio } = await import('../client/src/voice/tts');
    const { isMediaSessionKeeperActive } = await import(
      '../client/src/voice/mediaSessionKeeper'
    );

    await unlockDaemonTtsAudio();

    expect(isMediaSessionKeeperActive()).toBe(true);
    // unlockDaemonTtsAudio also primes the remote-audio element used
    // for the daemon's WebRTC TTS stream, so the body may have more
    // than one child. The keeper specifically is the one with the
    // silent WAV data URL.
    const keeperChild = doc.body.children.find((c) =>
      c.src.startsWith('data:audio/wav;base64,'),
    );
    expect(keeperChild).toBeDefined();
    expect(keeperChild?.loop).toBe(true);
    expect(keeperChild?.muted).toBe(false);
  });
});
