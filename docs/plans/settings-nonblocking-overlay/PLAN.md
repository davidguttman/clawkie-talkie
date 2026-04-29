# Settings Nonblocking Overlay Implementation Plan

## Scope

Implement only the approved design: Settings becomes a nonblocking overlay over
the current app surface. Do not move voice, RTC, media-session, hold music, STT,
or TTS ownership. Do not make History or Transcript overlays in this change.

## Files Likely To Change

- `client/src/app.tsx`
  - Remove Settings from the exclusive screen route union.
  - Add `settingsOpen` overlay state.
  - Render Settings above existing screen content without unmounting the base
    screen.
  - Add small local overlay shell component(s), inline with existing App shell
    style.
- `test/appSettingsOverlay.test.ts` (new)
  - Source-level structure tests that pin Settings as overlay state and prevent
    the old full-screen route regression.
- `test/appRouting.test.ts`
  - No expected changes unless TypeScript or test expectations need small
    updates after removing Settings from `ScreenId`.
- `test/drivingScreen.test.ts`
  - No expected changes; keep existing Settings gear assertions. Update only if
    implementation changes the callback shape in a way the source-level test
    needs to recognize.

Files intentionally not in scope:

- `client/src/screens/Driving.tsx`
- `client/src/voice/drivingLoop.ts`
- `client/src/voice/tts.ts`
- `client/src/voice/holdMusic.ts`
- `client/src/voice/mediaSession.ts`
- `client/src/voice/mediaSessionKeeper.ts`
- `client/src/rtc/RtcContext.tsx`
- daemon files

## Ordered Implementation Steps

1. Add failing structure tests in `test/appSettingsOverlay.test.ts`.
2. Assert `client/src/app.tsx` no longer contains
   `| 'settings' |` or equivalent in `ScreenId`.
3. Assert `client/src/app.tsx` does not call `go('settings')`.
4. Assert `client/src/app.tsx` does not render a
   `screen === 'settings'` branch.
5. Assert `client/src/app.tsx` has explicit overlay state such as
   `settingsOpen`.
6. Assert `DrivingScreen` still receives `onSettings`.
7. Assert `SettingsScreen` is rendered from overlay state and not from base
   screen state.
8. Update `client/src/app.tsx` `ScreenId` to
   `driving | history | transcript | error`.
9. Add `const [settingsOpen, setSettingsOpen] = useState(false)` in `App`.
10. Keep `settings`, `setSettingsState`, `saveSettings`, and `RtcProvider`
    exactly at App/provider level.
11. Change Driving `onSettings` from `go('settings')` to
    `setSettingsOpen(true)`.
12. Remove the old `screen === 'settings'` branch from `screenContent`.
13. Create an `appContent` wrapper that renders `screenContent` first and the
    Settings overlay second when `settingsOpen` is true.
14. Pass `appContent` into `ResponsiveRuntime`; keep `RtcProvider` and
    `RtcDisconnectGate` wrapping unchanged.
15. Add a local `SettingsOverlay` component in `client/src/app.tsx`.
16. Make the overlay fill the runtime surface with `position: absolute` and
    `inset: 0`.
17. Ensure the parent wrapper establishes `position: relative`, `height: 100%`,
    `minHeight: 0`, and `overflow: hidden` so desktop phone and mobile runtime
    both contain the overlay.
18. Add a scrim layer that captures pointer events. Use close-on-scrim only if
    it is straightforward; otherwise deliberately keep scrim clicks no-op.
19. Render `SettingsScreen` inside a full-height panel with
    `onBack={() => setSettingsOpen(false)}`.
20. Add dialog accessibility attributes on the overlay panel:
    `role="dialog"`, `aria-modal="true"`, and `aria-label="Settings"`.
21. Optionally add an Escape key effect in `App` or `SettingsOverlay` that only
    closes `settingsOpen`; it must not call any runtime/audio cleanup.
22. Keep Error `session_replaced` behavior unchanged. The error gate may still
    replace the whole runtime when the daemon reports replacement.
23. Run focused tests and typecheck.
24. If tests expose source-level wording brittleness, update only the tests for
    the intended structural contract.

## Test Additions And Updates

### New: `test/appSettingsOverlay.test.ts`

Add tests that read `client/src/app.tsx` and assert:

- Settings is absent from `ScreenId`.
- `go('settings')` is absent.
- `screen === 'settings'` is absent.
- `settingsOpen` or the chosen overlay state identifier exists.
- `setSettingsOpen(true)` is wired from the Driving settings callback.
- `SettingsScreen` receives an `onBack` close callback using
  `setSettingsOpen(false)`.
- `RtcProvider` still appears outside `ResponsiveRuntime`.
- No App-level settings path imports or calls `stopMediaSessionKeeper`,
  `stt.cancel`, `reply.cancel`, or `stopHoldMusic`.

### Existing: `test/appRouting.test.ts`

Keep URL parsing expectations unchanged:

- invalid/default routes still produce bad-session error;
- valid handoff URLs still open Driving;
- session and thread metadata are still preserved.

Only update this file if TypeScript needs a narrower screen type expectation.

### Existing: `test/drivingScreen.test.ts`

Keep the current Settings gear test. Update only if necessary to keep asserting:

- Settings gear remains available in compact and desktop headers;
- the button remains gated only on `onSettings`, not `!compact`.

### Existing Regression Suite

Do not change these unless implementation unexpectedly breaks contracts:

- `test/drivingLoop.test.ts`
- `test/mediaSession.test.ts`
- `test/mediaSessionKeeper.test.ts`
- `test/settingsStorage.test.ts`
- `test/protocol.test.ts`
- `test/ttsVoice.test.ts`

## Verification Commands

Prerequisite if dependencies are missing in the worktree:

```sh
npm install
```

Focused checks:

```sh
npm exec vitest run test/appSettingsOverlay.test.ts test/appRouting.test.ts test/drivingScreen.test.ts test/drivingLoop.test.ts test/mediaSession.test.ts test/mediaSessionKeeper.test.ts test/settingsStorage.test.ts test/protocol.test.ts test/ttsVoice.test.ts
```

Typecheck:

```sh
npm run typecheck
```

Full test suite:

```sh
npm test
```

Build check:

```sh
npm run build
```

Do not run `npm run dev`, `npm run dev:client`, `npm run dev:daemon`, Docker, or
manual server lifecycle commands for this implementation unless explicitly
requested.

## Manual Verification Notes

Use only the project-owned service flow if runtime/device verification is later
requested.

- Open Settings while idle; close it; confirm the same session/status remains.
- Open Settings while hold music is active; confirm hold music continues.
- Open Settings during daemon TTS; confirm playback continues.
- Change voice while connected; confirm next reply uses the new voice without
  reconnecting.
- Change speed; confirm the next fallback TTS arm uses the new rate.
- Confirm Settings overlay captures clicks/touches and does not trigger PTT
  behind it.
- Confirm compact and desktop phone-frame layouts both contain the overlay.

## Risks

- A visually correct overlay can still be wrong if the underlying
  `DrivingScreen` is conditionally unmounted. The source-level App test must
  pin this.
- If the overlay wrapper lacks stable height/relative positioning, it may render
  outside the desktop phone frame or clip incorrectly on mobile.
- Escape or scrim-close handlers must only close overlay state. They must not
  route through `go('driving')` or any voice/audio cleanup.
- Hardware media controls will remain live while Settings is open. This is
  intentional per the approved design, but it may surprise users if they press
  AirPods controls while editing Settings.
- Existing source-level tests can become brittle if implementation naming
  differs. Prefer assertions on durable behavior/structure, not exact formatting.

## Rollback Notes

- Revert `client/src/app.tsx` to restore the previous exclusive Settings route.
- Remove `test/appSettingsOverlay.test.ts` if rolling back the overlay feature.
- Do not revert or touch voice/media/RTC files; they should not change for this
  implementation.
- If the overlay causes layout issues but state preservation works, roll back
  only the overlay shell styling while keeping Settings out of `ScreenId`.

## Ambiguity

- Scrim click behavior is not specified. Default recommendation: scrim captures
  events and does not close, while the Settings back button is the explicit close
  path. Close-on-scrim is acceptable only if product wants it.
- Escape-to-close is optional. It should be included only if it stays local to
  overlay state.
