# Clawkie-Talkie V1 Design Kickoff

Date: 2026-04-21
Status: validated brainstorming artifact
Project path: `/mnt/data/play/web/clawkie-talkie`
Primary design reference: `docs/design/Clawkie-Talkie Hi-Fi.html`

## One-line product definition

Clawkie-Talkie is a walkie-talkie voice surface for an existing OpenClaw session, optimized for phone use while driving, with the existing Discord/OpenClaw thread staying canonical.

## Core product shape

- This is a separate project, not an OpenClaw core feature.
- It is a voice surface layered on top of an existing OpenClaw session, not a separate hidden conversation.
- The canonical visual target is `docs/design/Clawkie-Talkie Hi-Fi.html`.
- Do not redesign the shell.
- If a surface is not implemented in V1, leave it in the layout and gray it out or disable it.
- The intended feel is strict walkie-talkie, not a phone call app.

## V1 goals

Build the fastest real playable slice that lets an OpenClaw user:

1. start from an existing OpenClaw/Discord session,
2. open Clawkie-Talkie on a phone,
3. speak a turn while seeing live streaming transcription,
4. tap stop to auto-send,
5. get the assistant reply back on the phone as text plus spoken audio,
6. keep the Discord/OpenClaw thread in sync.

## Hard constraints

### UX constraints

- One big obvious start/stop control.
- No VAD.
- No press-and-hold.
- No duplex conversation.
- No interruptible conversation.
- The user records one turn, stops, and waits for the reply.
- Live transcript is for monitoring and spoken self-correction while talking.
- There is no transcript edit-before-send step in V1.
- Tapping stop auto-sends immediately.
- Tapping silence on assistant playback only stops local playback. It does not stop inference.

### Architecture constraints

- Browser does streaming STT directly with xAI.
- Browser does streaming TTS directly with xAI.
- Do not move xAI STT/TTS server-side.
- Front-end to daemon communication uses WebRTC.
- Running a user-managed public HTTP(S) server is a non-starter.
- Installation/run flow must be easy for normal OpenClaw users.
- Use a LobsterLink-style rendezvous/handoff pattern.
- Rambly/OpenClaw plugin work is a valid precedent for daemon + realtime transport patterns.

### Product boundary constraints

- Do not drift into OpenClaw-core PR framing.
- Do not turn this into a packaging/distribution detour.
- Do not silently replace WebRTC with a localhost/public HTTP app shape.
- Do not remove features from the hi-fi layout just because they are not built yet.

## Canonical V1 architecture

Clawkie-Talkie V1 has three logical pieces:

### 1. Phone client

A phone-friendly client that matches `Clawkie-Talkie Hi-Fi.html`.

Responsibilities:

- join a voice session via handoff/join URL,
- establish WebRTC connection to the local daemon,
- capture microphone audio,
- stream audio to xAI STT directly from the browser,
- render live transcript while the user is speaking,
- finalize transcript text when the user taps Stop,
- send final transcript text to the daemon,
- receive final assistant reply text from the daemon,
- request xAI TTS directly from the browser,
- play assistant audio locally,
- preserve the existing shell even when some surfaces are disabled.

### 2. Local daemon on the OpenClaw machine

The daemon is an OpenClaw session bridge, not a media server.

Responsibilities:

- generate a LobsterLink-style join token/UUID,
- map that token to the target OpenClaw session id,
- participate in the WebRTC connection with the phone client,
- receive final transcript text from the browser,
- post the user turn into the Discord/OpenClaw thread as a quoted block,
- send the final transcript into the target OpenClaw session,
- get the final assistant reply,
- return final assistant text/status to the phone client,
- ensure the assistant reply is delivered into the canonical Discord/OpenClaw thread.

Non-responsibilities:

- no server-side STT,
- no server-side TTS,
- no per-user public internet-facing app server requirement,
- no richer transcript system of record for V1.

### 3. Existing OpenClaw session / Discord thread

The existing session remains canonical.

- Spoken user turns should appear in the thread as quoted text.
- Assistant replies should also be delivered into the thread.
- OpenClaw/Discord remains the source of truth for transcript/history in V1.

## Handoff and join model

### Product-facing shape

The product flow is:

1. user is already in an existing OpenClaw/Discord session,
2. user says something like "switch to voice",
3. system provides a voice join URL,
4. user opens it on phone,
5. phone becomes the voice surface for that same session.

### V1 implementation shape

- V1 does not require OpenClaw itself to generate the link.
- The daemon can generate a LobsterLink-style UUID/token.
- The join token is the primary handoff handle.
- The client may also receive the session id as metadata for organization.
- The future shape should already look like a real token-based join flow, not a throwaway hardcoded URL shape.

## Exact turn lifecycle

### User turn

1. Phone client is connected to the daemon over WebRTC.
2. User taps the main button to start a turn.
3. Browser streams transcription with xAI and shows live transcript on-screen.
4. If transcription is wrong, the user keeps talking and clarifies verbally.
5. User taps Stop.
6. Browser finalizes the transcript text.
7. Browser sends final transcript text to the daemon.

### Thread sync + assistant turn

1. Daemon posts the user turn into the Discord/OpenClaw thread as a quoted block.
2. Daemon submits the same final transcript into the target OpenClaw session.
3. Daemon waits for the final assistant reply.
4. Assistant reply is delivered into the thread.
5. Daemon returns final assistant text to the phone client.
6. Browser requests xAI TTS directly and plays the reply aloud.

## OpenClaw integration shape for V1

Because assistant text streaming back to the phone is not required for first playable, V1 can use a final-reply path instead of a streaming Gateway integration.

Implementation-critical point:

- `openclaw agent` can target the existing session and deliver the assistant reply.
- The user turn still needs to be posted separately into the thread as quoted text.

Practical V1 shape:

1. post quoted user transcript into the Discord thread using OpenClaw messaging/channel delivery,
2. call OpenClaw for the actual agent turn on the target session,
3. use reply delivery so the assistant message lands in the canonical thread,
4. return final assistant text to the phone client for browser-side TTS.

Known CLI note from local docs:

- `openclaw agent` supports `--session-id`, `--message`, and `--deliver`.
- There is no CLI `--stream` flag for token-level assistant output.
- If future versions require incremental assistant text to the phone, the daemon should move to a Gateway streaming/API path instead of relying on the CLI turn shape.

## Screen-by-screen V1 behavior

### Handoff landing

Implemented.

- Real entry path into the voice session.
- Can validate token/session association.
- Should reflect the actual join flow.

### Driving screen

Implemented.

- This is the center of gravity for V1.
- Big start/stop control remains primary.
- Live transcript while speaking is required.
- Thinking/waiting state is required.
- Assistant playback state is required.
- Silence button remains valid, but only stops local playback.

### History screen

Visible but disabled or gray if not real yet.

- Keep in layout.
- Do not remove or relayout it.
- It is not the source of truth in V1.

### Transcript screen

Visible but disabled or placeholder in V1.

- Keep in layout.
- Do not remove it.
- OpenClaw/Discord is the transcript source of truth for first playable.

### Settings screen

Implemented enough to support the actual loop.

Minimum V1 expectations:

- xAI API key entry,
- any necessary validation/test affordance,
- voice selection if needed by the design,
- only the minimum real controls needed for browser-owned STT/TTS.

Extra settings can remain visible but disabled.

### Error screens

Use the existing hi-fi error-shell shape.

Priority real errors for V1:

- invalid/expired join token,
- microphone permission denied,
- STT failure,
- TTS/playback failure,
- daemon/session connectivity failure.

## Explicit non-goals for V1

- No duplex or full-call behavior.
- No manual transcript editing before send.
- No assistant token streaming requirement to the phone.
- No server-side STT/TTS.
- No richer in-app transcript/history system as source of truth.
- No redesign of `Clawkie-Talkie Hi-Fi.html`.
- No removal of unimplemented surfaces from the layout.
- No requirement that end users run their own public HTTPS server.
- No packaging/upstream/platform detour before the first real playable loop exists.

## Installability / operator model

Clawkie-Talkie must be runnable by ordinary OpenClaw users.

That means:

- no expectation that users expose a public web server from their machine,
- no requirement to hand-roll public ingress for the daemon,
- reuse the LobsterLink-style connection pattern for remote phone access,
- keep the install story agent-friendly and lightweight,
- daemon should be a single local service/process shape, not a multi-service deployment problem.

## First-playable acceptance criteria

V1 is done when the following full loop works against a real existing OpenClaw session:

1. A daemon creates or serves a valid join token for a known session.
2. A phone opens the Clawkie-Talkie join flow and reaches the hi-fi shell.
3. The driving screen works with the existing layout intact.
4. The user can start a turn and see live streaming transcript in the browser.
5. The user can verbally self-correct by continuing to speak.
6. Tapping Stop auto-sends immediately.
7. The browser sends final transcript text to the daemon over WebRTC.
8. The daemon posts the spoken user turn into the Discord/OpenClaw thread as a quoted block.
9. The daemon submits that same turn into the correct OpenClaw session.
10. The assistant reply is delivered into the thread.
11. The daemon returns final assistant text to the phone client.
12. The browser generates and plays assistant reply audio through xAI TTS.
13. Not-yet-built surfaces remain present but disabled/grayed out rather than removed.

## References

- `docs/design/Clawkie-Talkie Hi-Fi.html`
- `docs/design/hifi-driving.jsx`
- `docs/design/hifi-errors.jsx`
- `docs/design/hifi-screens.jsx`
- `docs/design/variations-1-3.jsx`
- `docs/design/variations-4-5.jsx`
- Rambly precedent: `/home/dguttman/play/js/openclaw-plugin-rambly/src/daemon.ts`
- Rambly precedent: `/home/dguttman/play/web/rambly/cli/README.md`

## Notes for implementation kickoff

If this doc is used as the implementation kickoff artifact, the prompt must explicitly preserve all of the following:

- WebRTC front-end to daemon transport
- xAI-owned browser STT/TTS
- no user-managed public HTTP(S) server requirement
- LobsterLink-style join/rendezvous pattern
- existing hi-fi layout preserved
- disabled/grayed-out unbuilt surfaces instead of removals
- quoted user turn posting into the canonical Discord/OpenClaw thread
- assistant reply delivered into the same canonical thread
