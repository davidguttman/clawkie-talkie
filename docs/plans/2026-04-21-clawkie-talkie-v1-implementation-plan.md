# Clawkie-Talkie V1 Implementation Plan

Date: 2026-04-21
Status: **superseded (2026-04-28) on signaling, xAI key handling, and STT/TTS ownership** — historical context only
Kickoff artifact: `docs/plans/2026-04-21-clawkie-talkie-v1-design.md`
Canonical shell: `docs/design/Clawkie-Talkie Hi-Fi.html`
Project path: `/mnt/data/play/web/clawkie-talkie`

> **Superseded on 2026-04-23.** The "custom rendezvous service" path described here (the `rendezvous/` workspace, `--rendezvous-url`, SSE-based `/rooms/:token/subscribe`, `VITE_CT_RENDEZVOUS_URL`) has been abandoned. Clawkie-Talkie uses **PeerJS** against its public broker (LobsterLink's actual convention), with `?host=<peerId>` join URLs. Ignore Phase 1 as written, the rendezvous dir in the target layout, and every mention of "rendezvous server" / "signaling service" in this file.

> **Superseded on 2026-04-28.** The browser/localStorage xAI-key flow in this historical plan is obsolete. Current Clawkie-Talkie keeps `XAI_API_KEY` only in the local daemon's repo-root `.env`; the browser never receives or stores the key. STT/TTS are daemon-owned in the current implementation, with the browser acting as the WebRTC audio/control surface.

This plan is optimized for the **fastest real playable loop**, not completeness. Anything not required to land acceptance criteria 1–13 in the kickoff is explicitly deferred.

## Preserved design constraints

These are load-bearing. Do not silently relax any of them during implementation.

- **Transport:** phone ⇄ daemon is **WebRTC**. No localhost HTTP shim, no direct phone→xAI→OpenClaw plane that bypasses the daemon.
- **STT/TTS:** **superseded** — current implementation is daemon-owned. The browser does not call xAI directly and does not receive/store `XAI_API_KEY`.
- **Rendezvous:** LobsterLink-style token/UUID join handle. Signaling goes through a shared public rendezvous service — users do **not** run a public HTTP(S) server.
- **Shell:** `docs/design/Clawkie-Talkie Hi-Fi.html` is the canonical UI. Do not redesign. Unbuilt surfaces (History, Transcript, extra settings) stay **visible but disabled/grayed**.
- **Thread sync:** Every spoken user turn is posted as a **quoted block** into the canonical Discord/OpenClaw thread. Every assistant reply is **delivered into the same thread** via OpenClaw's `--deliver` path. The thread is the V1 source of truth; the app is not.
- **Turn model:** strict walkie-talkie. Tap-to-start, tap-to-stop auto-sends, one turn at a time. No VAD, no press-and-hold, no duplex, no interrupt-inference. "Silence" only stops local playback.
- **Operator model:** a single local daemon process on the user's OpenClaw machine. No extra services, no public ingress on the user's side.

## System shape (at a glance)

```
  ┌─────────────────────┐      WebRTC DataChannel +        ┌──────────────────────┐
  │ Phone client        │ ◀──────── signaling via ────────▶│ Local daemon         │
  │ (static PWA,        │     public rendezvous server     │ (Node process on     │
  │  hi-fi shell)       │                                  │  OpenClaw machine)   │
  │                     │                                  │                      │
  │  ├─ audio/control UI │                                  │  ├─ token registry   │
  │  ├─ PCM playback     │                                  │  ├─ WebRTC peer      │
  │  └─ WebRTC peer     │                                  │  └─ OpenClaw bridge  │
  └─────────────────────┘                                  └──────────┬───────────┘
                                                                      │
                                                        openclaw CLI  ▼
                                                            ┌──────────────────────┐
                                                            │ OpenClaw session     │
                                                            │  + Discord thread    │
                                                            │  (canonical record)  │
                                                            └──────────────────────┘
```

- Public static phone client is served from a fixed public URL (no per-user hosting).
- Public rendezvous server holds offers/answers/ICE candidates keyed by join token. It is thin and stateless per session; no media, no transcripts, no keys.
- Daemon holds the local `XAI_API_KEY` in `.env`, plus tokens, peer connections, STT/TTS, and OpenClaw invocation state.

## Target directory layout

```
clawkie-talkie/
├── docs/
│   ├── design/                         # existing — do not edit
│   └── plans/                          # this file lives here
├── client/                             # phone web app (static, public host)
│   ├── public/
│   │   └── index.html                  # built from Clawkie-Talkie Hi-Fi.html
│   ├── src/
│   │   ├── app.tsx                     # top-level app + router between screens
│   │   ├── screens/
│   │   │   ├── Handoff.tsx             # join token entry + validation
│   │   │   ├── Driving.tsx             # main start/stop screen (real state machine)
│   │   │   ├── Settings.tsx            # xAI key entry + voice
│   │   │   ├── History.tsx             # disabled placeholder
│   │   │   ├── Transcript.tsx          # disabled placeholder
│   │   │   └── ErrorScreen.tsx         # error kinds from hifi-errors.jsx
│   │   ├── rtc/
│   │   │   ├── client.ts               # RTCPeerConnection + DataChannel
│   │   │   └── signaling.ts            # rendezvous client (SSE/fetch)
│   │   ├── xai/
│   │   │   ├── stt.ts                  # streaming STT client
│   │   │   └── tts.ts                  # streaming TTS client + playback
│   │   ├── state/
│   │   │   └── drivingMachine.ts       # IDLE→REC→THINK→AI (from hifi-driving.jsx)
│   │   ├── storage.ts                  # historical only: settings persistence; no xAI key in current client
│   │   └── tokens.css / tokens.ts      # ported from hifi-tokens.js
│   ├── package.json
│   └── vite.config.ts                  # Vite + TS is fine; keep it small
├── daemon/                             # local node process
│   ├── src/
│   │   ├── index.ts                    # CLI entry
│   │   ├── rendezvous.ts               # registers token, signals to rendezvous
│   │   ├── rtc.ts                      # node WebRTC peer (werift or @roamhq/wrtc)
│   │   ├── openclaw.ts                 # spawn `openclaw agent` + thread post
│   │   ├── session.ts                  # token ↔ sessionId map
│   │   ├── tokens.ts                   # UUID generation, join URL formatting
│   │   └── types.ts
│   ├── bin/clawkie-talkie-daemon.ts
│   ├── package.json
│   └── tsconfig.json
├── rendezvous/                         # thin public signaling service
│   ├── src/
│   │   ├── index.ts                    # http server
│   │   ├── rooms.ts                    # token → peers map, TTL
│   │   └── sse.ts                      # SSE subscribe + POST signal
│   ├── package.json
│   └── tsconfig.json
├── README.md
└── package.json                        # workspaces root (optional)
```

Note: `docs/design/hifi-*.jsx` stay as read-only design references. The client ports their behavior and tokens into the build — it does not load them at runtime.

## Precedent to study (do not copy blindly)

- **WebRTC + signaling pattern:** `/home/dguttman/play/web/rambly/cli/src/signal.ts`, `rambly/cli/src/webrtc.ts`. Rambly already solved SSE-based signaling plus node WebRTC peer; reuse the shape, not the exact code.
- **Daemon lifecycle / stdin JSON control:** `/home/dguttman/play/js/openclaw-plugin-rambly/src/daemon.ts`. Same spawn-and-control pattern the OpenClaw plugin uses.
- **LobsterLink rendezvous UX:** `/home/dguttman/play/lobsterlink-5128d62ed980eb26f18f8ae2d197bcb2bf5dc698/` — `README.md`, `client/`, `bridge.html`. The `lobsterl.ink/?host=<uuid>` shape is the exact precedent for our `?join=<uuid>` URL.
- **Hi-Fi shell state machine:** `docs/design/hifi-driving.jsx` defines `IDLE/REC/THINK/AI`. Port this state machine verbatim into `client/src/state/drivingMachine.ts`; the only change is swapping scripted text for real STT/TTS streams.
- **Session string format:** `docs/design/hifi-screens.jsx` defines `agent:<agent>:<app>:<channelId>[:<threadId>]`. Keep this format; it is the `sessionId` passed to `openclaw agent --session-id`.

## External dependencies

- **xAI API:** current implementation uses the daemon-side `XAI_API_KEY` from `.env` for STT/TTS. Historical browser-owned endpoint work below is obsolete.
- **OpenClaw CLI:** `openclaw agent --session-id <sid> --message <text> --deliver` for the agent turn. User-quote posting uses OpenClaw's messaging/channel-send path (TBD: whether that's a flag on `openclaw agent`, a separate subcommand, or a small direct Discord post via the session's already-authed integration — resolved in Phase 3).
- **WebRTC on node:** `werift` (pure-JS, no native build) or `@roamhq/wrtc` (native, faster). Start with `werift` to keep install painless for OpenClaw users — install-ergonomics is a hard constraint.
- **Rendezvous hosting:** one small public HTTP service. Cheapest viable: Render/Fly/Cloudflare Workers. Must be reachable from both phone (any network) and daemon (user's home network).

## Phasing

Phases are ordered so each one ends in something runnable and incrementally closer to the full loop. Do not skip verification steps — each phase is a gate.

### Phase 0 — Repo bootstrap + shell port (target: ~half day)

**Goal:** turn the static hi-fi prototype into a real web app that renders on a phone, with routing between screens and disabled surfaces already in place.

Work:
- Replace the stub root `package.json` with a workspaces root (or keep three independent packages — whichever is lower friction).
- Scaffold `client/` with Vite + React + TypeScript.
- Port `hifi-tokens.js` and `hifi-*.jsx` into TS modules under `client/src/`. Keep class/token names so future design tweaks transfer cleanly.
- Wire screen routing: `?screen=handoff|driving|history|transcript|settings|error` matches the prototype. Settings and error screens must be reachable.
- Mark History and Transcript screens disabled/grayed per the kickoff. They stay in nav.
- Add `?join=<token>` URL parsing to route to Handoff.
- Historical only: settings persistence existed in this plan, but xAI key storage in the browser is obsolete. Current client must not store `XAI_API_KEY`.

Verify:
- Load the dev build on a real phone; Driving, Handoff, Settings render and look like the hi-fi.
- History and Transcript screens load but their interactive controls are disabled.
- `?screen=error&errorKind=mic_denied` renders the correct error shell.
- No runtime errors in the phone console.

### Phase 1 — Public rendezvous + WebRTC walking skeleton (target: ~1 day)

**Goal:** phone and daemon establish a WebRTC DataChannel via a shared public rendezvous, keyed by a join token. No STT/TTS yet, no OpenClaw yet.

Work:
- Implement `rendezvous/` as a small HTTP service:
  - `POST /rooms` — daemon registers `{ token }`, returns ack.
  - `GET /rooms/:token/subscribe` — SSE channel; both peers subscribe.
  - `POST /rooms/:token/signal` — relays SDP and ICE between peers.
  - Tokens expire on TTL (e.g., 15 min) or on explicit `DELETE`.
  - No auth in V1; token acts as the shared secret. Document this limitation.
- Deploy rendezvous to a fixed public URL. Hard-code that URL in both client and daemon builds; no per-user config.
- Implement `daemon/`:
  - CLI entry that accepts `--session-id <sid>` (and optional `--xai-key` only if we decide to proxy; by default no), generates a UUID token, POSTs it to rendezvous, and prints the join URL to stdout.
  - Spawn a node WebRTC peer; open an ordered reliable DataChannel named `ct-control`.
  - On DataChannel open, echo any string message back prefixed with `ECHO:`.
- Implement `client/src/rtc/` and wire Handoff:
  - Parse `?join=<token>`.
  - Subscribe to rendezvous, send answer-side SDP/ICE, open DataChannel.
  - Driving screen shows a tiny debug affordance to send a test string and render the echo (can be behind a `?debug=1` flag so it's invisible in prod).

Verify:
- Run daemon locally on the OpenClaw machine; copy the printed join URL to a phone on **cellular** (not the same LAN).
- Phone opens URL → DataChannel opens within a few seconds → echo round-trip works.
- Kill daemon → phone shows the "daemon/session connectivity failure" error screen.

### Phase 2 — Historical browser-owned xAI STT + TTS plan (obsolete)

**Goal:** obsolete historical direction. Current implementation keeps STT/TTS daemon-side and keeps the xAI key out of the browser.

Work:
- Obsolete: do not add client-side xAI STT or browser API-key handling. Daemon owns STT.
- Obsolete: do not add client-side xAI TTS or browser API-key handling. Daemon owns TTS and the browser plays returned audio.
- `client/src/state/drivingMachine.ts`: port the `IDLE → REC → THINK → AI → IDLE` machine from `hifi-driving.jsx`; current implementation receives transcript/reply/audio events from the daemon instead of calling xAI directly.
- Tap-Stop behavior: finalize STT, immediately (no edit step) send final transcript to daemon over DataChannel as `{type:"user_turn_final", text}`.
- Daemon: on `user_turn_final`, stub a reply like `"(stub) you said: ..."` and send `{type:"assistant_reply_final", text}` back after ~1s.
- Silence button: stops TTS playback only. Does not send anything to the daemon.
- Error surfaces: mic permission denied, STT stream failure, TTS failure all route to the existing hi-fi error screens.

Verify:
- On a phone, tap Start → see live partial transcript tracking what you say.
- Tap Stop → transcript finalizes → Thinking state → AI state plays audio from xAI TTS.
- xAI key is read by the daemon from `.env`. Missing/invalid daemon key routes to a sensible error. The browser must not store the key.
- Silence during playback kills audio but keeps the turn record intact.
- Driving state machine matches the hi-fi prototype's visual states.

### Phase 3 — Daemon ↔ OpenClaw bridge (target: ~1 day)

**Goal:** daemon actually drives a real OpenClaw session and posts into the real Discord thread.

Work:
- `daemon/src/openclaw.ts`:
  - `postQuotedUserTurn(sessionId, text)` — posts the user's spoken text as a quoted block into the canonical thread. Resolve the exact mechanism during this phase: it is either (a) a flag on `openclaw agent`, (b) a different OpenClaw CLI subcommand, or (c) a direct channel-post via OpenClaw's existing integration binding for that session. Do not invent a new ingress path — consult the user before picking (c).
  - `submitAgentTurn(sessionId, text)` — spawns `openclaw agent --session-id <sid> --message <text> --deliver`. Collects the final assistant text from stdout (exact capture shape to be confirmed; likely JSON mode or last-line stdout).
- Wire into the DataChannel handler: on `user_turn_final`, do the two posts in order (quoted user turn → agent turn), then send `{type:"assistant_reply_final", text}`.
- Error-path routing: if `openclaw agent` fails or times out, send `{type:"assistant_reply_error", reason}` and surface the right error screen on the phone.
- Ensure the quoted user turn lands in the thread **before** the agent turn is submitted, so thread ordering reads naturally.

Verify:
- Run against a real OpenClaw session; the Discord thread shows, in order: quoted user turn → assistant reply.
- Phone plays the exact reply text that landed in the thread.
- Force a CLI failure (bad session id) → phone shows correct error.

### Phase 4 — Real token-based join flow + Handoff screen polish (target: ~half day)

**Goal:** Handoff screen reflects the real join flow end-to-end, and the token/session association is validated before entering Driving.

Work:
- Daemon prints join URL in a LobsterLink-style shape: `https://<client-host>/?join=<uuid>`. Configurable only via env var on the daemon side.
- Rendezvous exposes `GET /rooms/:token/info` returning `{ exists, expiresAt, sessionLabel? }` — enough to let the phone validate the token before handing off to Driving.
- Client Handoff screen: on load, validates token, shows expected error screen on invalid/expired, shows confirmation state on success.
- Pass the session string as metadata so the Handoff screen can show "you're connecting to `agent:main:discord:...`" — matches the hi-fi layout's detail area.

Verify:
- Expired token → `bad_session` error screen.
- Valid token → Handoff confirms, then transitions cleanly to Driving.
- Copy-paste a join URL from daemon stdout into the phone browser and reach Driving without manual steps.

### Phase 5 — Settings minimum + disabled-surface pass + error-path sweep (target: ~half day)

**Goal:** nothing rough-edged remains on the paths exercised by acceptance criteria; unbuilt surfaces feel intentional.

Work:
- Settings: no xAI API key entry in the browser. Show a daemon-held-key notice/status instead. Voice selection can remain if needed; everything else stays visible but disabled with a consistent "coming soon" treatment.
- History and Transcript: final pass to ensure they're present, styled, and consistently disabled. Do **not** wire them to any backing store.
- Error screens: sweep all five priority errors (invalid/expired token, mic denied, STT failure, TTS/playback failure, daemon/session connectivity failure) and confirm each can actually trigger and renders the right hi-fi state.

Verify:
- Fresh install: configure daemon `.env`, confirm Settings shows daemon-held-key status, complete a full turn.
- Disabled surfaces never throw and never pretend to work.
- Each priority error can be forced and shows the correct screen.

### Phase 6 — Acceptance criteria run-through (target: ~half day)

**Goal:** walk the 13-step acceptance loop from the kickoff on a real phone against a real OpenClaw session, end to end, uninterrupted.

Work:
- Dry-run the loop twice: once on the same LAN as the daemon, once on cellular.
- Fix any issues discovered. Do **not** add features found to be missing unless they are required by acceptance criteria 1–13.
- Capture a short write-up of what worked and what didn't, to inform V2 planning.

Verify:
- All 13 acceptance steps pass back-to-back, twice.

## Non-goals / explicit deferrals

Everything in the kickoff's "Explicit non-goals for V1" section still applies. Calling out the specific items most likely to be tempting during implementation:

- No streaming assistant text from daemon to phone. Final-reply path only. (If this turns out to be required, it is a V2 Gateway-streaming scope, not a V1 fix.)
- No in-app history, transcript store, or search. Thread is canonical.
- No transcript-edit-before-send.
- No VAD, no press-and-hold, no duplex, no interrupting the model.
- No packaging/distribution detour (no Homebrew, no npm-publish ceremony, no installer). Ship runnable from the repo.
- No auth on the rendezvous beyond token-as-bearer. Token rotation and real auth are V2.
- No multi-daemon, no multi-session per daemon. One daemon serves one session at a time for V1.
- No history of previous voice turns restored across app reloads.
- No silence-detection auto-stop. Stop is user-driven only.

## Risks and unknowns to validate early

Each of these should be touched in or before the phase named — if it breaks, the plan shape has to change, so do not discover it in Phase 6.

1. **xAI streaming STT/TTS API shape (current daemon-owned path).** Pin exact daemon-side endpoints, auth, audio formats, and partial-result framing. Do not add browser-side xAI calls or browser API-key storage.
2. **Node WebRTC install ergonomics (Phase 1).** `@roamhq/wrtc` native build has historically been painful cross-platform. If installing the daemon for a normal OpenClaw user means a native compile, that violates the installability constraint. Default to `werift` unless perf forces otherwise.
3. **OpenClaw `--deliver` reply capture (Phase 3).** Confirm exactly how to read the final assistant text from the CLI. If stdout isn't structured, we may need JSON-mode or a supported alternative. Do not guess — read the CLI's current behavior or ask the user.
4. **Quoted user-turn posting path (Phase 3).** Verify whether OpenClaw has a supported "post into the thread on behalf of the user" primitive, or whether we need to post via the same integration the session already uses. Do not invent a new ingress path silently.
5. **NAT traversal without a TURN server (Phase 1).** Home networks with symmetric NATs may fail WebRTC even with STUN. If any test network fails to connect over cellular, either add a public STUN/TURN (Twilio, Cloudflare, self-hosted coturn) or budget for this as a known gap. Test early.
6. **Mobile browser audio capture constraints (Phase 2).** iOS Safari has quirks around `getUserMedia`, background audio, and `MediaRecorder` codecs. Test on iOS early; if the chosen capture path doesn't work there, swap to `AudioWorklet` + raw PCM before finishing Phase 2.
7. **Rendezvous hosting reachability (Phase 1).** Confirm both a residential home network and mobile carriers can reach the chosen rendezvous host over HTTPS and keep a long-lived SSE connection open.
8. **xAI key handling (current).** The key lives only in the daemon `.env`. The phone/browser must not store it in `localStorage`, log it, or transmit it outside the daemon's xAI calls.

## Verification summary

A V1 build is accepted when, on a phone over cellular, against a daemon running on a real OpenClaw machine and a real Discord session:

1. Copy-paste the daemon's join URL into the phone browser.
2. Handoff validates and transitions to Driving.
3. Tap Start → live streaming transcript.
4. Keep talking, self-correct verbally.
5. Tap Stop → instant auto-send.
6. Discord thread shows the quoted user turn, then the assistant reply, in that order.
7. Phone plays daemon-provided audio generated via xAI TTS.
8. Silence stops playback but does not kill the turn record.
9. History and Transcript are visible, styled, and disabled.
10. The five priority error screens are each reachable under their real failure conditions.

If any of those fail, the build is not V1 yet — regardless of how close everything else looks.
