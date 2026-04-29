# Settings Nonblocking Overlay Design

## Goal

Settings must open over the active voice app without tearing down conversation,
audio, playback, hold music, media-session controls, RTC state, or session
state. The hard requirement is: opening or closing Settings must not behave like
a full-screen route transition away from Driving.

## Discovered Facts

- `client/src/app.tsx` owns a single `screen` union:
  `driving | history | transcript | settings | error`.
- The Driving gear calls `go('settings')`; Settings back calls
  `go('driving')`.
- `screenContent` renders each screen conditionally. Therefore the current
  Settings path unmounts `DrivingScreen`.
- `RtcProvider` is already above `screenContent`, so switching to Settings does
  not by itself unmount the RTC provider or close the RTC client.
- `DrivingScreen` owns `useDrivingLoop()`. That hook owns active STT, data-channel
  TTS fallback, hold music, transcript accumulation, wave state, and current
  reducer state.
- `useDrivingLoop()` has an unmount cleanup that cancels STT, stops TTS, and
  stops hold music.
- `DrivingScreen` owns `useMediaSessionControls()` and also stops the
  media-session keeper on unmount.
- The remote WebRTC TTS audio element is module-level in `voice/tts.ts` and is
  attached from `RtcProvider`, but the current TTS turn listener/handle is still
  owned by `useDrivingLoop()`.
- Settings itself is pure UI around `settings` and `setSettings`. It does not
  need to own session, audio, or routing.
- Voice changes already flow through `RtcProvider` as `settings.update` on the
  open voice room. Speaking speed is passed to `useDrivingLoop()` and should
  affect the next daemon TTS fallback arm, not forcibly mutate active playback.

## Current Reset Path

Opening Settings currently does this:

1. User clicks Driving gear.
2. `App.go('settings')` updates the exclusive `screen` state.
3. The `screen === 'driving'` branch stops rendering.
4. `DrivingScreen` unmounts.
5. `useDrivingLoop()` cleanup cancels mic/STT, stops TTS, and stops hold music.
6. `useMediaSessionControls()` cleanup clears media action handlers and sets
   playback state to `none`.
7. `DrivingScreen` cleanup stops the media-session keeper.

That is the state-killing behavior to remove for Settings.

## Proposed Behavior

Settings becomes app overlay state, not a `ScreenId`.

- Replace the Settings route transition with an overlay flag, for example
  `settingsOpen`.
- `onSettings` should set `settingsOpen = true`.
- Settings back/close should set `settingsOpen = false`.
- Keep the existing base screen mounted while the overlay is open. In the
  current UI, Settings is reachable from Driving, so the immediate hard
  requirement is that `DrivingScreen` remains mounted.
- Render the overlay inside the same `ResponsiveRuntime` content so it appears
  inside the phone frame on desktop and over the mobile runtime on narrow
  screens.
- Keep `RtcProvider` where it is. Do not make Settings own or wrap RTC state.
- Keep `settings` state in `App` so persistence and `RtcProvider` voice updates
  continue to use the existing path.
- Do not cancel, pause, silence, restart, or reconnect audio/session work when
  opening or closing Settings.

## UI Behavior

- The overlay should cover the active app surface and capture pointer/touch
  events so accidental taps do not hit the PTT button behind it.
- The active app may remain visually visible behind a dim or blurred scrim, but
  the implementation must not use conditional rendering that unmounts it.
- The Settings surface can reuse `SettingsScreen` to preserve existing controls
  and storage behavior.
- The Settings back button closes the overlay, returning to the exact underlying
  state.
- Escape-to-close is acceptable on desktop if implemented without touching
  voice state.
- Screen-reader behavior should use a dialog-style boundary (`role="dialog"`,
  `aria-modal="true"` or equivalent). The background should be inaccessible to
  normal UI focus while the overlay is open, but the runtime must continue.

## State Ownership Boundaries

- `App`: owns base screen, settings overlay open/closed state, settings
  persistence, current transcript selection, and responsive shell choice.
- `RtcProvider`: owns connection/session room lifecycle and daemon stream
  attachment. It must stay mounted across Settings open/close.
- `DrivingScreen` and `useDrivingLoop`: own live voice turn state, mic/STT,
  TTS fallback, hold music, media-session controls, and visualization. These
  must stay mounted across Settings open/close.
- `SettingsScreen`: owns only UI edits for local settings. It must not trigger
  navigation or runtime teardown.
- `HistoryScreen` and `TranscriptScreen`: remain full-screen routes for this
  task unless product scope later says they also must be overlays.

## Risks And Open Questions

- Hardware media controls will continue to use the live Driving state while
  Settings is open. That preserves current media-session behavior. If product
  wants Settings to suppress AirPods/lock-screen PTT, that should be an explicit
  follow-up because suppression itself changes active session behavior.
- Source-level tests are common in this repo. They are useful for pinning
  "Settings is not a screen route", but they should be paired with at least one
  behavior-oriented test if the test stack is expanded.
- History and Transcript still unmount Driving. That is outside this Settings
  requirement, but it is the same architectural pattern.
- Targeted Vitest verification, typecheck, full tests, and build are expected
  to run from the existing project dependency install.

## Key Recommendation

Implement Settings as a modal overlay flag in `App`, rendered above the existing
screen content inside the runtime shell. Do not move voice, RTC, or audio state
into Settings; simply stop treating Settings as an exclusive screen.
