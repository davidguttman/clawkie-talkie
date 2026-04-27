// Silent media-session keeper.
//
// Background: iOS Safari (and to a lesser extent Android Chrome) only
// delivers `navigator.mediaSession` action handlers to a page that the
// OS considers to have an *active* media session. The handlers we
// register in `./mediaSession.ts` therefore won't reach AirPods /
// lock-screen play-pause buttons while the page is idle unless some
// audio element is actually playing.
//
// This keeper is that element. After the user's first trusted gesture
// (the PTT tap path that calls `unlockDaemonTtsAudio()`), we attach a
// hidden looping `<audio>` element fed from a tiny silent PCM16 WAV
// data URL. iOS treats a non-muted, playing element as an active
// media session, so subsequent AirPods presses route through our
// `setActionHandler('play' | 'pause' | 'stop')` callbacks even when
// the app is otherwise idle.
//
// Constraints:
// - Source is silent samples (no audible output even at full volume),
//   so volume can stay at 1 / muted=false. Muted elements don't hold
//   a media session on iOS, which would defeat the point.
// - The element is its own DOM node — kept separate from the hidden
//   audio element used to play the daemon's WebRTC TTS stream so the
//   two paths don't interfere (different srcObject vs src lifecycles,
//   different play() lifecycles).
// - Pure no-op when the DOM is absent (SSR, jsdom without HTMLAudio).

let keeperEl: HTMLAudioElement | null = null;
let cachedSilentWavDataUrl: string | null = null;

const SILENT_WAV_DURATION_SECONDS = 0.5;
const SILENT_WAV_SAMPLE_RATE = 8000;

export interface AudioElementDebugSnapshot {
  present: boolean;
  paused: boolean | null;
  currentTime: number | null;
  readyState: number | null;
  src: string | null;
  events: {
    playCount: number;
    pauseCount: number;
    last: {
      type: 'play' | 'pause';
      timestampMs: number;
      ageMs: number;
    } | null;
  };
}

let keeperEventDebug: {
  playCount: number;
  pauseCount: number;
  last: { type: 'play' | 'pause'; timestampMs: number } | null;
} = {
  playCount: 0,
  pauseCount: 0,
  last: null,
};

function snapshotAudioElement(el: HTMLAudioElement | null): AudioElementDebugSnapshot {
  const now = Date.now();
  return {
    present: !!el,
    paused: el ? el.paused : null,
    currentTime: el ? el.currentTime : null,
    readyState: el ? el.readyState : null,
    src: el ? el.currentSrc || el.src || null : null,
    events: {
      playCount: keeperEventDebug.playCount,
      pauseCount: keeperEventDebug.pauseCount,
      last: keeperEventDebug.last
        ? {
            ...keeperEventDebug.last,
            ageMs: Math.max(0, now - keeperEventDebug.last.timestampMs),
          }
        : null,
    },
  };
}

export function getMediaSessionKeeperDebugSnapshot(): AudioElementDebugSnapshot {
  return snapshotAudioElement(keeperEl);
}

export function attachMediaSessionKeeperDebugHost(host: HTMLElement): () => void {
  const el = keeperEl;
  if (!el) return () => {};

  const previousParent = el.parentNode;
  const previousNextSibling = el.nextSibling;
  const previousCssText = el.style.cssText;
  const previousControls = el.controls;
  const previousAriaHidden = el.getAttribute('aria-hidden');

  el.controls = true;
  el.setAttribute('aria-hidden', 'false');
  el.style.position = 'static';
  el.style.width = '100%';
  el.style.height = '32px';
  el.style.opacity = '1';
  el.style.pointerEvents = 'auto';
  el.style.display = 'block';
  host.appendChild(el);

  return () => {
    if (keeperEl !== el) return;
    el.controls = previousControls;
    if (previousAriaHidden === null) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', previousAriaHidden);
    el.style.cssText = previousCssText;
    try {
      if (previousParent) previousParent.insertBefore(el, previousNextSibling);
      else if (typeof document !== 'undefined') document.body.appendChild(el);
    } catch {
      if (typeof document !== 'undefined') document.body.appendChild(el);
    }
  };
}

// Build a 0.5 s mono PCM16 8 kHz WAV of all-zero samples and base64
// encode it as a data URL. Cached at module scope so we only do the
// (small) build once. Exported for tests.
export function buildSilentWavDataUrl(
  durationSeconds: number = SILENT_WAV_DURATION_SECONDS,
  sampleRate: number = SILENT_WAV_SAMPLE_RATE,
): string {
  const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = samples * 2;
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  // RIFF / WAVE header
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  buf.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  // "fmt " chunk
  buf.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // "data" chunk (samples are already zero from Uint8Array init)
  buf.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);

  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(bin)
      // Node fallback for tests not running in a browser-like env.
      : (globalThis as { Buffer?: { from(bin: string, enc: string): { toString(enc: string): string } } })
          .Buffer
        ? (globalThis as unknown as { Buffer: typeof Buffer }).Buffer.from(bin, 'binary').toString('base64')
        : '';
  return `data:audio/wav;base64,${b64}`;
}

function getSilentWavDataUrl(): string {
  if (cachedSilentWavDataUrl) return cachedSilentWavDataUrl;
  cachedSilentWavDataUrl = buildSilentWavDataUrl();
  return cachedSilentWavDataUrl;
}

function pokePlay(el: HTMLAudioElement): Promise<void> {
  try {
    const r = el.play();
    if (r && typeof (r as Promise<void>).then === 'function') {
      return (r as Promise<void>).then(
        () => undefined,
        () => undefined,
      );
    }
  } catch {
    // ignore — autoplay rejection is non-fatal; the element will
    // just not hold a media session until the next gesture.
  }
  return Promise.resolve();
}

function recordKeeperEvent(type: 'play' | 'pause'): void {
  if (type === 'play') keeperEventDebug.playCount += 1;
  else keeperEventDebug.pauseCount += 1;
  keeperEventDebug.last = { type, timestampMs: Date.now() };
}

function attachKeeperEventDebug(el: HTMLAudioElement): void {
  el.addEventListener('play', () => recordKeeperEvent('play'));
  el.addEventListener('pause', () => recordKeeperEvent('pause'));
}

// Idempotent. Safe to call from every PTT tap; the second+ call just
// re-pokes play() (browsers can auto-pause silent media in the
// background, and a re-poke from a fresh gesture re-establishes it).
// No-op when the DOM is unavailable.
export function startMediaSessionKeeper(): void {
  if (typeof document === 'undefined') return;

  if (keeperEl) {
    void pokePlay(keeperEl);
    return;
  }

  let el: HTMLAudioElement;
  try {
    el = document.createElement('audio');
  } catch {
    return;
  }

  try {
    el.src = getSilentWavDataUrl();
    el.loop = true;
    el.autoplay = true;
    el.preload = 'auto';
    // Non-muted is required for iOS to consider this an active media
    // session. Volume stays at the default 1 — the WAV itself is silent.
    el.muted = false;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('aria-hidden', 'true');
    attachKeeperEventDebug(el);
    el.style.position = 'absolute';
    el.style.width = '0';
    el.style.height = '0';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    keeperEl = el;
    void pokePlay(el);
  } catch {
    keeperEl = null;
  }
}

export function stopMediaSessionKeeper(): void {
  const el = keeperEl;
  keeperEl = null;
  if (!el) return;
  try {
    el.pause();
  } catch {
    // ignore
  }
  try {
    el.removeAttribute('src');
    el.load();
  } catch {
    // ignore
  }
  try {
    el.remove();
  } catch {
    // ignore — element may have already been detached
  }
}

export function isMediaSessionKeeperActive(): boolean {
  return !!keeperEl;
}

// Test seam: forget cached state without touching the DOM.
export function _resetMediaSessionKeeperForTests(): void {
  keeperEl = null;
  cachedSilentWavDataUrl = null;
  keeperEventDebug = {
    playCount: 0,
    pauseCount: 0,
    last: null,
  };
}
