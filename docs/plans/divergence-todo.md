# Todo List: Align Clawkie-Talkie with Design Document

## Priority: CRITICAL (Must Fix ASAP)

### [CRITICAL] #3 - Remove Direct LLM Calls, Use OpenClaw Commands ✅
**Status:** DONE — `daemon/src/chatSession.ts` rewritten to use `openclaw agent --deliver --session-id` CLI.

### [CRITICAL] #6 - Remove Custom Signaling Server, Use LobsterLink Pattern ✅
**Status:** DONE — `daemon/src/signaling.ts` deleted; daemon and client both use public PeerJS broker directly.

### [CRITICAL] #7 - Generate UUID/token for Handoff, Don't Hardcode ✅
**Status:** DONE — `daemon/src/uuid.ts` generates UUID per session; `DAEMON_PEER_ID` env var allowed as dev override only. `?host=<uuid>` is the only join mechanism.

## Priority: HIGH

### [HIGH] #1 & #2 - Browser-Side STT/TTS via xAI
**Issue:** STT and TTS are handled server-side by daemon instead of browser-side.
**Locations:**
- `daemon/src/` (remove STT/TTS handling)
- `client/src/voice/sttDaemon.ts` (needs to use xAI directly)
- `client/src/voice/tts.ts` (needs to use xAI directly)
**Fix Required:**
- Move STT from daemon to browser using xAI streaming WebSocket
- Move TTS from daemon to browser using xAI streaming
- Browser must authenticate with xAI (browser has xAI key, daemon does not)
- Keep PCM transport between browser and daemon (WebRTC datachannel)
- Verify browser has proper xAI API key handling for direct WebSocket auth
**Status:** NOT STARTED — STT/TTS remain daemon-terminated. The xAI streaming WS does support browser-side auth, but this is a larger change that moves xAI key into browser. Deferred pending further review.

### [HIGH] #5 - Add Activity Notifications for OpenClaw Integration
**Issue:** No debug/activity notifications sent to OpenClaw thread.
**Locations:**
- All daemon signal handling
- `client/src/voice/drivingLoop.ts`
**Fix Required:**
- Follow patterns from `scripts/daily-focus/scripts/receiving-code-review.ts`
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
**Status:** PARTIALLY DONE — sessionId/threadId plumbing exists (connection labels). Full thread integration (posting user turns as quoted blocks, delivering replies to canonical thread) is not yet wired to Discord.

### [HIGH] #8 (continued) - Remove Client-Side TTS
**Issue:** Client-side TTS code exists but should be handled by daemon.
**Location:** `client/src/voice/tts.ts`
**Fix Required:**
- Remove TTS player from browser
- Browser should only play PCM if daemon streams it (for future use)
- Daemon handles all TTS via xAI and streams PCM back
**Status:** NOT STARTED — daemon-side TTS is working. Client-side PCM playback is still in place. This is actually the correct architecture (daemon generates TTS PCM and streams it to client over WebRTC). The item description appears to be wrong.

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
**Status:** PARTIALLY DONE — sessionId is passed to daemon CLI and threaded through connection labels. Full OpenClaw context integration not yet complete.

### [MEDIUM] Settings Screen - Remove xAI Key Entry
**Issue:** Settings UI has xAI key entry but browser doesn't need it.
**Location:**
- `client/src/screens/Settings.tsx`
**Fix Required:**
- Remove xAI API key input from frontend settings
- Keep only browser-relevant settings (microphone, TTS voice, etc.)
- If dev needs to configure, use `.env` or URL params only
**Status:** NOT STARTED — Settings screen shows "DAEMON-HELD" notice but does not have an xAI key input field to remove. This may already be done or not applicable.

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
| 1/2 | Move STT/TTS to browser | HIGH | NOT STARTED |
| 5 | Activity notifications | HIGH | NOT STARTED |
| 8 | Discord thread integration | HIGH | PARTIAL |
| 8 | Remove client-side TTS | HIGH | NOT STARTED |
| 8 | OpenClaw session context | MEDIUM | PARTIAL |
| MED | Settings xAI key removal | MEDIUM | NOT STARTED |
| LOW | General cleanup | LOW | NOT STARTED |
