# Todo List: Align Clawkie-Talkie with Design Document

## Priority: CRITICAL (Must Fix ASAP)

### [CRITICAL] #3 - Remove Direct LLM Calls, Use OpenClaw Commands ✅
**Status:** DONE — `daemon/src/chatSession.ts` rewritten to use `openclaw agent --deliver --session-id` CLI + debug notifications.

### [CRITICAL] #6 - Remove Custom Signaling Server, Use LobsterLink Pattern ✅
**Status:** DONE — `daemon/src/signaling.ts` deleted; daemon and client both use public PeerJS broker directly.

### [CRITICAL] #7 - Generate UUID/token for Handoff, Don't Hardcode ✅
**Status:** DONE — `daemon/src/uuid.ts` generates UUID per session; `DAEMON_PEER_ID` env var allowed as dev override only. `?host=<uuid>` is the only join mechanism.

## Priority: HIGH

### [HIGH] #5 - Add Activity Notifications for OpenClaw Integration ✅
**Status:** DONE — `daemon/src/peer.ts` now sends debug activity notifications via `openclaw message send --channel discord --target "channel:<id>"` for all key events:
- `stt_start` / `stt_ready` / `stt_done` / `stt_error` / `stt_connection_closed`
- `chat_start` / `chat_done` / `chat_error`
- `tts_start` / `tts_audio_start` / `tts_done` / `tts_error` / `tts_session_error`
- User turn is posted as quoted block and reply delivered to canonical thread.

### [HIGH] #8 - Discord Thread Integration ✅
**Status:** DONE — Full integration implemented:
- User turn posted as quoted block via `openclaw agent --deliver --session-id <sid> --message "User said: ..." --reply-channel discord --reply-to "channel:<tid>"`
- Assistant reply delivered into same canonical thread
- Debug notifications sent via `openclaw message send --channel discord --target "channel:<tid>"`
- sessionId/threadId flow through connection labels working end-to-end.

### [HIGH] #8 (continued) - Remove Client-Side TTS
**Status:** NOT APPLICABLE — client TTS is only PCM playback from daemon. Architecture is correct.

## Priority: MEDIUM

### [MEDIUM] #8 - OpenClaw Session Integration ✅
**Status:** DONE — sessionId passed to daemon CLI and threaded through connection labels. Full context integration available via OpenClaw `--session-id` flag.

### [MEDIUM] Settings Screen - Remove xAI Key Entry ✅
**Status:** DONE — Settings screen already displays "DAEMON-HELD" notice; no xAI key input field exists. Key lives on daemon machine only.

## Priority: LOW

### [LOW] General Cleanup
- Remove unused xAI API key handling from frontend
- Verify all error handling follows OpenClaw patterns
- Update documentation to match implementation
**Status:** NOT STARTED

## Implementation Status Summary

| # | Item | Priority | Status |
|---|------|----------|--------|
| 3 | Replace direct xAI calls with OpenClaw CLI | CRITICAL | ✅ DONE |
| 6 | Remove custom signaling, use public broker | CRITICAL | ✅ DONE |
| 7 | UUID per session instead of hardcoded ID | CRITICAL | ✅ DONE |
| 5 | Activity notifications | HIGH | ✅ DONE |
| 8 | Discord thread integration | HIGH | ✅ DONE |
| 8 | Remove client-side TTS | HIGH | NOT APPLICABLE |
| 8 | OpenClaw session context | MEDIUM | ✅ DONE |
| MED | Settings xAI key removal | MEDIUM | ✅ DONE |
| LOW | General cleanup | LOW | NOT STARTED |
