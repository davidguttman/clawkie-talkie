# Agent Response UX Timing Plan

## Goal

Delay the visible agent-response transition until response audio actually starts. While the daemon has produced text but audio has not started, the user should remain on the thinking/hold-music screen, with the hold-music mute control still available.

## Current Behavior

- `client/src/voice/drivingReducer.ts`
  - In `thinking`, `reply.done` immediately changes state to `ai`, stores `lastReplyText`, copies it into `liveReplyText`, and emits `armTts`.
  - `tts.start` is currently not handled by the reducer.
- `client/src/voice/drivingLoop.ts`
  - The control listener dispatches `reply.done` when text arrives and `tts.start` when audio begins.
  - `reply.done` does not stop hold music, but the reducer state change to `ai` hides the thinking UI/mute affordance.
  - `tts.start`, `tts.done`, `tts.error`, and `reply.error` stop hold music via `stopHoldMusicForControlMessage`.
  - `displayedCaptionText()` shows `ctx.liveReplyText` while state is `ai`.
- `client/src/screens/Driving.tsx`
  - `pickCaption()` shows the agent text box in `ai`.
  - `PTTButton` exposes the hold-music mute/unmute control only while state is `thinking`.
  - `Caption` currently auto-scrolls the transcript to the bottom on every `caption.text` change.

## Implementation Plan

1. Update the driving reducer state model in `client/src/voice/drivingReducer.ts`.
   - Add a pending reply field to `DrivingContext`, likely `pendingReplyText: string`.
   - Initialize it in `initialContext` and clear it when starting a new recording turn.
   - In `thinking` + `reply.done`, stay in `thinking`, store only `pendingReplyText`, keep `lastReplyText` unchanged, keep `liveReplyText` empty, and emit `armTts`.
   - Do not write `lastReplyText` on `reply.done`. `lastTurn` displays `lastReplyText` in idle, so storing it before audio starts would leak unseen agent text after `tts.error`, `tts.done`, or user cancel.
   - In `thinking` + `tts.start`, transition to `ai`, copy `pendingReplyText` into both `lastReplyText` and `liveReplyText`, and clear `pendingReplyText`.
   - On every pre-start exit path (`tts.error`, `tts.done`, `reply.error`, and user cancel before `tts.start`), return to `idle` and clear `pendingReplyText` without exposing it through `lastReplyText` or `liveReplyText`.
   - Treat `tts.start` with no current pending reply as stale/out-of-order and avoid copying any previous-turn text into the current AI caption.

2. Keep the TTS player arming point unchanged in `client/src/voice/drivingLoop.ts`.
   - Continue arming TTS from the `reply.done` side effect so the phone is listening before daemon audio frames arrive.
   - Continue dispatching `tts.start` from the control listener; that event becomes the UI transition trigger.
   - Keep `stopHoldMusicForControlMessage()` stopping hold music on `tts.start`, `tts.done`, `tts.error`, and `reply.error`.
   - Revisit `syncHoldMusicForDrivingState()` once the reducer changes. Since `ai` will mean audio has started, it can stop music on `ai`, or the existing `tts.start` stop can remain the source of truth. Tests should encode the chosen behavior.

3. Update caption scroll behavior in `client/src/screens/Driving.tsx`.
   - Remove the unconditional `el.scrollTop = el.scrollHeight` effect.
   - Add a small scroll-state guard in `Caption`:
     - When the AI response caption appears, reset `scrollTop` to `0`.
     - Track user scroll interaction via `onScroll`/pointer/wheel/touch so subsequent text changes do not force the box to the bottom.
     - Do not auto-scroll the agent response unless the user manually scrolls.
   - Do not key this behavior on `!caption.live`: the current AI response caption is `live: true` (`AI · READING ALOUD`).
   - Preserve live recording/transcribing behavior separately if needed; the requested no-auto-bottom rule is specifically for the response text box when the AI response appears.

4. Leave screen labels and button logic mostly intact in `client/src/screens/Driving.tsx`.
   - Because state remains `thinking` between `reply.done` and `tts.start`, the existing `THINKING` status, hold-music visual state, and mute/unmute PTT affordance should remain visible.
   - Once `tts.start` transitions to `ai`, the existing `AI · READING ALOUD` caption and response text rendering should appear.

## Tests To Update/Add

- `test/drivingReducer.test.ts`
  - Change the `reply.done` test to assert state remains `thinking`, `pendingReplyText` is populated, `lastReplyText`/`liveReplyText` are not populated with the new response, and `armTts` is emitted.
  - Add/adjust a `tts.start` test to assert transition to `ai`, `liveReplyText` becomes the pending reply, and no extra side effects fire.
  - Add regression coverage for `reply.done -> tts.error`: reducer returns to `idle`, clears `pendingReplyText`, and does not expose the pending reply as `lastReplyText`/last AI text.
  - Add regression coverage for `reply.done -> tap`: cancel returns to `idle`, clears `pendingReplyText`, and does not expose the unseen reply.
  - Add regression coverage for stale/out-of-order `tts.start`: if there is no pending reply for the current turn, do not show previous-turn text as the AI response.
  - Update the happy-path sequence to `idle -> recording -> thinking -> reply.done still thinking -> tts.start -> ai -> tts.done -> idle`.
  - Keep `displayedCaptionText()` expectations that the reply only appears in `ai`.

- `test/drivingLoop.test.ts`
  - Update hold-music state-gate expectations so `reply.done` does not stop music and `tts.start` is the first speech-start stop point.
  - If `syncHoldMusicForDrivingState('ai')` changes to stop music, update the current "carries through pre-speech ai state" test because `ai` will no longer represent pre-speech.

- `test/drivingScreen.test.ts`
  - Add a source or DOM-level assertion that `Caption` no longer contains unconditional bottom scrolling (`scrollTop = scrollHeight`).
  - Add coverage for resetting the response scroll container to the top specifically when the AI response appears. This test should assert the positive top-scroll behavior, not only the absence of bottom-scroll code.
  - Keep existing hold-music mute control assertions; they should continue to pass because state remains `thinking` until `tts.start`.

## Edge Cases

- `reply.done` arrives but `tts.start` is delayed: stay in `thinking`, keep music and mute/unmute available, do not show reply text.
- `reply.done` arrives then `tts.error`: stop hold music and return to idle with the TTS error surfaced; do not briefly show the reply text.
- `reply.done` arrives then user taps while no current STT is finalizing: preserve existing cancel behavior by sending `reply.cancel`, stopping any armed TTS handle, clearing pending reply, and returning to idle.
- `tts.start` arrives with an empty or missing pending reply: transition should not crash; show an empty AI caption or fall back to the last stored reply text only if that is explicitly chosen in implementation.
- `tts.start` arrives before `reply.done`: treat as out-of-order and avoid showing stale text from a previous turn.
- Long agent replies: the response box starts at the top, remains user-scrollable, and does not jump to the bottom on render or later state updates.
- Multiple turns: pending reply and scroll state reset at the start of each new turn so previous response text/scroll position cannot leak into the next turn.
