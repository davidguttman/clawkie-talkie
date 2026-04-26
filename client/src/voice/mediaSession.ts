// Hardware / lock-screen media controls (AirPods play-pause, Bluetooth
// headset buttons, the iOS lock-screen and Android notification
// transport, etc.) reach the page via the `navigator.mediaSession`
// API. The same handler fires for play, pause, and stop, so we map all
// three to the existing PTT tap so a single AirPods pinch toggles
// recording the same way tapping the on-screen button does.
//
// Mapping (matches DrivingState semantics):
//   * idle → tap()        // start recording
//   * recording → tap()   // stop recording, advance to thinking
//   * thinking / ai → no-op
//
// The "thinking / ai → no-op" choice is deliberate: while the agent is
// generating a reply or speaking, an accidental AirPods press should
// not silently start a new mic capture or cancel speech. The user can
// still cancel a turn from the UI; hardware controls only drive the
// PTT toggle. This keeps the headset behaviour predictable and matches
// what the PTT button already does (the Driving screen disables clicks
// on the PTT button while state === 'thinking').
//
// `playbackState` is set so a single hardware press alternates
// naturally: paused while idle, playing while recording / thinking /
// ai. Some platforms use the state to decide whether the next press
// fires `play` vs `pause`; we register a handler for both either way.

import { useEffect } from 'react';
import type { DrivingState } from './drivingReducer';

const HANDLED_ACTIONS = ['play', 'pause', 'stop'] as const;
type HandledAction = (typeof HANDLED_ACTIONS)[number];

export interface MediaSessionLike {
  setActionHandler(action: string, handler: (() => void) | null): void;
  playbackState?: 'none' | 'paused' | 'playing';
  metadata?: unknown;
}

// Pure decision: what should a hardware media-control press do given
// the current driving state? Exposed for tests so we don't have to
// drive a full DOM mediaSession to assert the routing.
export function shouldStartOrStopOnMediaControl(state: DrivingState): boolean {
  return state === 'idle' || state === 'recording';
}

// Pure decision: which playbackState should we publish for a given
// driving state? `paused` while idle so the next hardware press
// resolves to `play` (which we map to "start recording"); `playing`
// otherwise so it resolves to `pause` (which we map to "stop / cancel
// when state allows").
export function playbackStateFor(state: DrivingState): 'paused' | 'playing' {
  return state === 'idle' ? 'paused' : 'playing';
}

// Resolve `navigator.mediaSession`, returning null when unavailable
// (SSR, very old Safari, browsers that don't ship the API). Exported
// for tests.
export function getMediaSession(): MediaSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  const ms = (navigator as unknown as { mediaSession?: MediaSessionLike })
    .mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return null;
  return ms;
}

// Optional metadata. Set lazily and only once per page; we don't
// change it across turns so iOS doesn't flicker the now-playing card.
let metadataInstalled = false;
function ensureMetadata(ms: MediaSessionLike): void {
  if (metadataInstalled) return;
  metadataInstalled = true;
  try {
    const MM = (globalThis as unknown as {
      MediaMetadata?: new (init: { title: string }) => unknown;
    }).MediaMetadata;
    if (MM) {
      ms.metadata = new MM({ title: 'Clawkie-Talkie' });
    }
  } catch {
    // Best-effort; metadata is purely cosmetic.
  }
}

// Test-only seam: forget that metadata was installed so per-test
// modules start clean.
export function _resetMediaSessionForTests(): void {
  metadataInstalled = false;
}

// Install handlers + publish playbackState. Returns a cleanup that
// removes the handlers (passing `null` to setActionHandler is the
// spec-defined way to detach). Safe to call when the API is missing —
// returns a no-op cleanup.
export function installMediaSessionControls(opts: {
  state: DrivingState;
  onTrigger: () => void;
}): () => void {
  const ms = getMediaSession();
  if (!ms) return () => {};

  ensureMetadata(ms);

  const handler = () => {
    if (shouldStartOrStopOnMediaControl(opts.state)) opts.onTrigger();
  };

  for (const action of HANDLED_ACTIONS) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Some browsers throw on unsupported actions even when the API
      // is otherwise present. Skip those and keep going.
    }
  }

  try {
    ms.playbackState = playbackStateFor(opts.state);
  } catch {
    // Read-only in some embedding contexts; ignore.
  }

  return () => {
    for (const action of HANDLED_ACTIONS) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
    try {
      ms.playbackState = 'none';
    } catch {
      // ignore
    }
  };
}

// React hook wrapping installMediaSessionControls. Re-installs on
// state change so the handler closure always sees the freshest state
// (and so `playbackState` tracks the driving loop). Cleans up on
// unmount.
export function useMediaSessionControls(
  state: DrivingState,
  onTrigger: () => void,
): void {
  useEffect(() => {
    return installMediaSessionControls({ state, onTrigger });
  }, [state, onTrigger]);
}

export type { HandledAction };
