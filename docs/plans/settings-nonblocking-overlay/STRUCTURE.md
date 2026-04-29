# Settings Nonblocking Overlay Implementation Structure

## Phase 1: Pin Current Contract

1. Add a focused test that reads `client/src/app.tsx`.
2. Assert Settings is not represented as an exclusive `ScreenId`.
3. Assert no code path calls `go('settings')`.
4. Assert `DrivingScreen` still receives an `onSettings` callback.
5. Assert Settings rendering is controlled by overlay state, not by
   `screen === 'settings'`.
6. Run the new focused test.
7. Verifiable output: failing test that describes the current route-based
   teardown risk.

## Phase 2: Convert App State

1. In `client/src/app.tsx`, remove `settings` from `ScreenId`.
2. Add app state for `settingsOpen`.
3. Keep existing `settings` and `setSettingsState` ownership in `App`.
4. Change Driving `onSettings` to open the overlay.
5. Change Settings `onBack` to close the overlay.
6. Remove the exclusive `screen === 'settings'` branch.
7. Keep `RtcProvider` wrapping the full runtime exactly as it does today.
8. Keep `DrivingScreen` rendered whenever the base `screen` is `driving`.
9. Do not touch `DrivingScreen`, `useDrivingLoop`, `RtcContext`, TTS, hold
   music, or media-session logic in this phase.
10. Verifiable output: opening Settings no longer changes base `screen`.

## Phase 3: Build Overlay Shell

1. Add a small overlay wrapper in `App` or a local component near App.
2. Render `{screenContent}` first.
3. Render the Settings overlay above it when `settingsOpen` is true.
4. Position the overlay absolutely within the runtime surface.
5. Use a scrim that captures pointer events.
6. Place Settings in a full-height panel suitable for the phone frame and mobile
   runtime.
7. Reuse `SettingsScreen` for the panel content.
8. Ensure the panel has a dialog role and useful accessible name.
9. Optionally close on Escape.
10. Ensure clicking the scrim either closes Settings or does nothing
    deliberately; do not let it pass through to PTT.
11. Verifiable output: Settings appears above the current app surface, and the
    underlying component tree remains mounted.

## Phase 4: Expand Tests

1. Update the source-level test from Phase 1 to pass.
2. Add or update tests that pin the Settings gear remains present in Driving.
3. Add a test that `DrivingScreen` is not conditionally removed when Settings is
   open. Prefer behavior tests if a React DOM test helper is available; otherwise
   keep a source-level assertion consistent with existing tests.
4. Keep existing tests for media session, media-session keeper, driving loop,
   protocol, settings storage, and app routing.
5. Run focused tests:
   `vitest run test/appRouting.test.ts test/drivingScreen.test.ts test/drivingLoop.test.ts test/mediaSession.test.ts test/mediaSessionKeeper.test.ts test/settingsStorage.test.ts test/protocol.test.ts`.
6. Run full `npm test` when dependencies are installed.
7. Verifiable output: tests show Settings is overlay-only and existing runtime
   contracts still pass.

## Phase 5: Manual Runtime Checks

1. Use the project-owned service flow only; do not manually start or kill Node
   servers.
2. Join a valid voice session.
3. Open Settings while idle.
4. Close Settings and confirm the same session label/status remains.
5. Start recording, then open Settings from another reachable state only if the
   UI allows it; otherwise validate no app path opens Settings during recording.
6. Trigger a thinking state with hold music, open Settings, and confirm hold
   music continues until daemon speech starts or the turn ends.
7. Trigger daemon TTS, open Settings, and confirm playback continues.
8. Change voice in Settings and confirm the next TTS turn uses the new voice.
9. Change speaking speed and confirm the next fallback TTS playback uses it.
10. Confirm closing Settings returns to the exact live surface without a reload.
11. Verifiable output: no connection reset, no session replacement, no audio
    cancellation, and no lost transcript turn caused by Settings.
