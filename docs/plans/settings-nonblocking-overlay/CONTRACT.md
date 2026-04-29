# Settings Nonblocking Overlay Contract

## Acceptance Checklist

- Opening Settings from Driving does not unmount `DrivingScreen`.
- Opening Settings does not run `useDrivingLoop()` unmount cleanup.
- Opening Settings does not cancel an active STT capture.
- Opening Settings does not send `stt.cancel` or `reply.cancel`.
- Opening Settings does not stop active daemon TTS playback.
- Opening Settings does not stop hold music while the app is thinking.
- Opening Settings does not stop or remove the media-session keeper.
- Opening Settings does not clear `navigator.mediaSession` handlers or set
  playback state to `none`.
- Opening Settings does not close or recreate `RtcProvider` or `RtcClient`.
- Closing Settings restores the same underlying app state without rebuilding the
  voice runtime.
- Changing voice in Settings still persists locally and sends `settings.update`
  over the existing voice room when connected.
- Changing speaking speed persists locally and applies to the next local
  fallback TTS arm.
- Export settings still affect Transcript export.
- Settings remains reachable on compact and desktop layouts.
- Overlay input does not leak through to the PTT button or other controls behind
  Settings.
- The session-replaced error gate can still supersede the active runtime when
  the daemon reports `session.replaced`.

## Test Plan

### Static / Unit

- `test/appRouting.test.ts`: keep URL and handoff parsing behavior unchanged.
- New or updated App structure test:
  - no `settings` member in `ScreenId`;
  - no `go('settings')`;
  - no `screen === 'settings'` render branch;
  - Settings rendered from overlay state;
  - Driving remains the base screen while overlay state is true.
- `test/drivingScreen.test.ts`: keep the Settings gear available in compact and
  desktop headers.
- `test/drivingLoop.test.ts`: existing hold music, TTS, and visualization gates
  remain unchanged.
- `test/mediaSession.test.ts`: existing media-session handler install/cleanup
  semantics remain unchanged; Settings must avoid triggering cleanup.
- `test/mediaSessionKeeper.test.ts`: existing keeper start/stop semantics remain
  unchanged; Settings must avoid calling stop.
- `test/settingsStorage.test.ts`: settings persistence and export settings
  boundaries remain unchanged.
- `test/protocol.test.ts` and `test/ttsVoice.test.ts`: voice settings protocol
  remains unchanged.

### Manual / Device

- Idle: open and close Settings; confirm no reload, reconnect, or status reset.
- Recording: if Settings can be opened, confirm recording continues or the UI
  explicitly prevents opening without cancelling state. Do not silently cancel.
- Thinking with hold music: open Settings; hold music continues until normal
  daemon transition.
- AI/TTS playback: open Settings; playback continues and transcript persists.
- Remote WebRTC TTS path: open Settings during remote stream playback; hidden
  audio element remains attached.
- Data-channel PCM fallback path: open Settings during fallback playback; current
  fallback handle is not stopped.
- Media controls: after opening Settings, AirPods/lock-screen controls still
  follow the existing Driving-state rules.
- Voice setting: change voice while connected; next reply uses the new voice
  without reconnecting.
- Speed setting: change speed; next fallback playback uses the new rate.
- Compact layout: overlay fits without clipping settings controls.
- Desktop phone frame: overlay stays inside the phone surface and does not cover
  the browser outside the frame.

## Non-Acceptance Examples

- Settings implemented by navigating to a full-screen `settings` route.
- Settings implemented by hiding Driving through conditional rendering that
  unmounts its hooks.
- Any Settings open/close path that calls `stopMediaSessionKeeper()`.
- Any Settings open/close path that cancels STT, TTS, reply generation, hold
  music, or RTC.
- A close action that creates a fresh Driving loop instead of revealing the
  existing one.
