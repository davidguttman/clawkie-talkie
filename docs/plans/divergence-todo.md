# Todo List: Align Clawkie-Talkie with Design Document

## Priority: CRITICAL (Must Fix ASAP)

### [CRITICAL] #3 - Remove Direct LLM Calls, Use OpenClaw Commands
**Issue:** Current code calls xAI directly for chat completions instead of using OpenClaw's message/agent commands.
**Location:** `daemon/src/chatSession.ts`
**Fix Required:**
- Replace `runChat()` function that calls xAI API directly
- Use `openclaw agent` CLI command with `--message` and `--session-id` flags
- Follow patterns from:
  - `/home/dguttman/play/js/openclaw-plugin-rambly/src/daemon.ts` (Rambly precedent)
  - `/home/dguttman/play/web/rambly/cli/README.md`
  - `scripts/daily-focus/scripts/receiving-code-review.ts` (example of OpenClaw activity notifications)
- Implement proper "debug" activity notifications as shown in claude code and codex wake scripts
- Ensure assistant reply is delivered into the canonical Discord/OpenClaw thread

### [CRITICAL] #6 - Remove Custom Signaling Server, Use LobsterLink Pattern
**Issue:** Daemon runs its own PeerJS signaling server instead of using public broker pattern.
**Locations:** 
- `daemon/src/signaling.ts`
- `daemon/src/peer.ts`
- `client/src/rtc/client.ts`
**Fix Required:**
- Remove `startSignalingServer()` and all signaling server code
- Use public PeerJS broker (lobsterlink pattern) exactly as in Rambly
- Implement `?host=<peerId>` URL pattern for join flow
- Phone discovers daemon via public broker, not local signaling server
- Ensure `DAEMON_PEER_ID` is NOT hardcoded; use URL parameter pattern
- Use `peerId` from URL query parameter, not deterministic local ID

### [CRITICAL] #7 - Generate UUID/token for Handoff, Don't Hardcode
**Issue:** Hardcoded `DAEMON_PEER_ID = 'ct-daemon'` instead of generating UUID/token.
**Locations:**
- `daemon/src/peer.ts`
- `client/src/rtc/client.ts`
**Fix Required:**
- Generate UUID/token per session in daemon
- Expose token via `?host=<uuid>` join URL
- Token must be generated fresh each session, not hardcoded
- Allow `.env` override only for dev/testing (not hardcoded anywhere)

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

### [HIGH] #8 (continued) - Remove Client-Side TTS
**Issue:** Client-side TTS code exists but should be handled by daemon.
**Location:** `client/src/voice/tts.ts`
**Fix Required:**
- Remove TTS player from browser
- Browser should only play PCM if daemon streams it (for future use)
- Daemon handles all TTS via xAI and streams PCM back

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

### [MEDIUM] Settings Screen - Remove xAI Key Entry
**Issue:** Settings UI has xAI key entry but browser doesn't need it.
**Location:** 
- `client/src/screens/Settings.tsx`
**Fix Required:**
- Remove xAI API key input from frontend settings
- Keep only browser-relevant settings (microphone, TTS voice, etc.)
- If dev needs to configure, use `.env` or URL params only

## Priority: LOW

### [LOW] General Cleanup
- Remove unused xAI API key handling from frontend
- Clean up any server-side TTS/STT session code that's no longer needed
- Verify all error handling follows OpenClaw patterns
- Update documentation to match implementation
- Remove Rambly-specific code if not needed

## Implementation Order (Suggested)

1. Fix #6 - Remove custom signaling, implement LobsterLink pattern
2. Fix #7 - Generate UUID/token for sessions
3. Fix #3 - Replace direct LLM calls with OpenClaw commands
4. Fix #1/#2 - Move STT/TTS to browser if xAI WS auth is possible
5. Fix #5 - Add activity notifications
6. Fix #8 - Add Discord/OpenClaw thread integration
7. Fix #8 - Remove client-side TTS
8. Fix #8 - Add OpenClaw session context
9. Fix #LOW - Cleanup and documentation