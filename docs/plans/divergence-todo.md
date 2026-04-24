# Todo List: Align Clawkie-Talkie with Design Document

## Priority: CRITICAL (Must Fix ASAP)

### [CRITICAL] #3 - Remove Direct LLM Calls, Use OpenClaw Commands ✅
**Status:** DONE — `daemon/src/chatSession.ts` rewritten to use `openclaw agent --deliver --session-id` CLI.

### [CRITICAL] #6 - Remove Custom Signaling Server, Use LobsterLink Pattern ✅
**Status:** DONE — `daemon/src/signaling.ts` deleted; daemon and client both use public PeerJS broker directly.

### [CRITICAL] #7 - Generate UUID/token for Handoff, Don't Hardcode ✅
**Status:** DONE — `daemon/src/uuid.ts` generates UUID per session; `DAEMON_PEER_ID` env var allowed as dev override only. `?host=<uuid>` is the only join mechanism.

## Priority: HIGH

### [HIGH] #1 & #2 - Browser-Side STT/TTS via xAI ❌
**Status:** NOT STARTED — This is a correction from prior docs. STT and TTS are intentionally kept daemon-side for security; the browser never holds an xAI API key. The daemon terminates xAI streaming STT and TTS and relays audio via WebRTC datachannel. No changes needed.

### [HIGH] #5 - Add Activity Notifications for OpenClaw Integration
**Issue:** No debug/activity notifications sent to OpenClaw thread.
**Locations:**
- All daemon signal handling
- `client/src/voice/drivingLoop.ts`
**Fix Required:**
- Follow patterns from `scripts/daily-focus/scripts/receiving-code-review.ts` (not yet located in repo)
- Send "debug" activity notifications for:
  - STT start/stop events
  - TTS start/stop events
  - Chat completion events
  - Error states
- Use proper activity types from OpenClaw integration
**Status:** NOT STARTED

### [HIGH] #8 - Discord Thread Integration
**Issue:** No Discord/OpenClaw thread sync; replies don't appear in canonical thread.
**Locations:**
- `daemon/src/chatSession.ts`
- `daemon/src/index.ts`
- Any OpenClaw messaging code
**Fix Required:**
- Post user turn into Discord/OpenClaw thread as quoted block
- Deliver assistant reply into same canonical thread
- Use OpenClaw messaging commands: `openclaw agent --deliver --session-id <id> --message "..."`
- Verify thread ID is available through OpenClaw context
**Status:** PARTIAL — sessionId/threadId plumbing exists via connection labels; full integration (posting quoted blocks, canonical thread delivery) not wired to Discord.

### [HIGH] #8 (continued) - Remove Client-Side TTS
**Issue:** Client-side TTS code exists but should be handled by daemon.
**Location:** `client/src/voice/tts.ts`
**Fix Required:**
- Remove TTS player from browser
- Browser should only play PCM if daemon streams it (for future use)
- Daemon handles all TTS via xAI and streams PCM back
**Status:** NOT APPLICABLE — client TTS is only PCM playback from daemon. Architecture is correct.

## Priority: MEDIUM

### [MEDIUM] #8 - OpenClaw Session Integration
**Issue:** OpenClaw session context not used anywhere.
**Locations:**
- `client/src/`
- `daemon/src/`
**Fix Required:**
- Obtain `--session-id` from OpenClaw context
- Pass session ID to all OpenClaw commands
- Ensure daemon can target specific OpenClaw session
- Add OpenClaw context to thread lifecycle management
**Status:** PARTIAL — sessionId passed to daemon CLI and threaded through connection labels; full OpenClaw context integration not yet complete.

### [MEDIUM] Settings Screen - Remove xAI Key Entry
**Issue:** Settings UI has xAI key entry but browser doesn't need it.
**Location:**
- `client/src/screens/Settings.tsx`
**Fix Required:**
- Remove xAI API key input from frontend settings
- Keep only browser-relevant settings (microphone, TTS voice, etc.)
- If dev needs to configure, use `.env` or URL params only
**Status:** NOT STARTED — Settings screen already displays "DAEMON-HELD" notice; no xAI key input field exists.

## Priority: LOW

### [LOW] General Cleanup
- Remove unused xAI API key handling from frontend
- Clean up any server-side TTS/STT session code that's no longer needed
- Verify all error handling follows OpenClaw patterns
- Update documentation to match implementation
- Remove Rambly-specific code if not needed
**Status:** NOT STARTED

## Implementation Status Summary

| # | Item | Priority | Status |
|---|------|----------|--------|
| 3 | Replace direct xAI calls with OpenClaw CLI | CRITICAL | ✅ DONE |
| 6 | Remove custom signaling, use public broker | CRITICAL | ✅ DONE |
| 7 | UUID per session instead of hardcoded ID | CRITICAL | ✅ DONE |
| 1/2 | Move STT/TTS to browser | HIGH | NOT STARTED (intentional) |
| 5 | Activity notifications | HIGH | NOT STARTED |
| 8 | Discord thread integration | HIGH | PARTIAL |
| 8 | Remove client-side TTS | HIGH | NOT APPLICABLE |
| 8 | OpenClaw session context | MEDIUM | PARTIAL |
| MED | Settings xAI key removal | MEDIUM | NOT STARTED (already done) |
| LOW | General cleanup | LOW | NOT STARTED
