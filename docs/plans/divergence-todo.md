# Todo List: Align Clawkie-Talkie with Design Document

> **Note:** Items #1, #2, #4 are ACCEPTED — server-side STT/TTS is fine because xAI does not support browser-side WebSocket authentication.

## Priority: CRITICAL (Must Fix ASAP)

### [CRITICAL] #3 - Use OpenClaw Commands for LLM, Not Direct xAI Calls
**Issue:** Direct xAI chat calls bypass OpenClaw session/thread.
**Location:** `daemon/src/chatSession.ts`
**Fix Required:**
- Replace `runChat()` that calls xAI API directly
- Use `openclaw agent --deliver --session-id --thread-id` CLI
- Ensure replies appear in canonical Discord/OpenClaw thread
**Status:** ✅ DONE

### [CRITICAL] #6 - Use LobsterLink Pattern, Not Custom Signaling Server
**Issue:** Daemon runs its own PeerJS signaling server.
**Locations:** `daemon/src/signaling.ts`, `daemon/src/peer.ts`
**Fix Required:**
- Remove `startSignalingServer()` and all signaling server code
- Use public PeerJS broker (LobsterLink pattern)
- Phone discovers daemon via public broker, not local server
**Status:** ✅ DONE — `daemon/src/signaling.ts` deleted; daemon uses public PeerJS broker directly.

### [CRITICAL] #7 - Generate UUID/Token Per Session, No Hardcoded ID
**Issue:** Hardcoded `DAEMON_PEER_ID = 'ct-daemon'`.
**Locations:** `daemon/src/peer.ts`
**Fix Required:**
- Generate UUID/token per session
- Expose via `?host=<uuid>` join URL
- Allow `.env` override only for dev/testing
**Status:** ✅ DONE — `daemon/src/uuid.ts` generates fresh UUID per session; `DAEMON_PEER_ID` env var only for dev override.

## Priority: HIGH

### [HIGH] #5 - Add Activity Notifications for OpenClaw Integration
**Issue:** No debug/activity notifications sent to OpenClaw thread.
**Locations:**
- `daemon/src/peer.ts`
- `client/src/voice/drivingLoop.ts`
**Fix Required:**
- Follow patterns from `scripts/daily-focus/scripts/receiving-code-review.ts`
- Send "debug" activity notifications for STT/TTS/chat events
- Use proper OpenClaw activity types
**Status:** NOT STARTED

### [HIGH] #8 - Discord/OpenClaw Thread Integration
**Issue:** No thread sync; replies don't appear in canonical thread.
**Locations:**
- `daemon/src/chatSession.ts`
- `daemon/src/index.ts`
**Fix Required:**
- Post user turn into Discord thread as quoted block
- Deliver assistant reply into same canonical thread
- Wire thread ID from connection context
**Status:** PARTIALLY DONE — sessionId/threadId plumbing exists. Full Discord thread posting not yet wired.

## Priority: MEDIUM

### [MEDIUM] OpenClaw Session Context
**Issue:** OpenClaw session context not fully integrated.
**Locations:** `daemon/src/`
**Fix Required:**
- Pass `--session-id` and `--thread-id` to all OpenClaw commands
- Ensure daemon targets correct OpenClaw session
**Status:** PARTIALLY DONE — sessionId passed to daemon CLI and through connection labels.

### [MEDIUM] Settings Screen Cleanup
**Issue:** Settings UI may have xAI key entry (key is server-side).
**Location:** `client/src/screens/Settings.tsx`
**Fix Required:**
- Ensure no xAI key input in frontend settings
- Browser-relevant settings only (microphone, etc.)
**Status:** LIKELY DONE — Settings shows "DAEMON-HELD" notice, no key input field.

## Priority: LOW

### [LOW] General Cleanup
- Update documentation to match implementation
- Verify error handling follows OpenClaw patterns
- Remove any obsolete code comments
**Status:** NOT STARTED

---

## Implementation Status Summary

| # | Item | Priority | Status |
|---|------|----------|--------|
| 3 | Replace direct xAI calls with OpenClaw CLI | CRITICAL | ✅ DONE |
| 6 | Remove custom signaling, use public broker | CRITICAL | ✅ DONE |
| 7 | UUID per session instead of hardcoded ID | CRITICAL | ✅ DONE |
| 5 | Activity notifications | HIGH | NOT STARTED |
| 8 | Discord/OpenClaw thread integration | HIGH | PARTIAL |
| MED | OpenClaw session context | MEDIUM | PARTIAL |
| MED | Settings cleanup | MEDIUM | LIKELY DONE |
| LOW | General cleanup | LOW | NOT STARTED |

**Accepted (no change needed):**
- #1 — Server-side STT (xAI lacks browser WS auth)
- #2 — Server-side TTS (xAI lacks browser WS auth)
- #4 — Daemon as media server (fine because of #1+#2)
