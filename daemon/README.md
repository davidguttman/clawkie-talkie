# Clawkie-Talkie daemon

Single-session walking skeleton. Answers the phone's WebRTC offer, pipes
mic PCM16 frames received on `ct-control` into xAI's streaming STT
WebSocket (Authorization header auth on the daemon side), and relays
`transcript.partial` / `transcript.done` events back to the phone.

## One-time install

From the repo root:

    npm install --workspaces

The daemon depends on `@roamhq/wrtc` (native prebuilds for macOS /
Linux / Windows) and `ws`.

## Run

### Client env

Not required for the normal flow. The daemon bakes its `--rendezvous-url`
into the printed join URL as a `rendezvous=` query param, and the phone
client reads that directly — so the printed URL is self-contained.

A `VITE_CT_RENDEZVOUS_URL` fallback exists only for the edge case where
the app is opened without a rendezvous in the URL (see
`client/.env.example`). If that fallback is also missing, the Handoff
screen reports `DAEMON · ERROR · missing_rendezvous_url`.

### Services

In one terminal, start the rendezvous:

    npm run rendezvous

In a second terminal, start the daemon against the rendezvous (required
`XAI_API_KEY` env var holds your key server-side; the phone never sees
it):

    XAI_API_KEY=xai-... npm run daemon -- \
      --session-id agent:main:discord:<channelId>:<threadId> \
      --rendezvous-url http://localhost:8787 \
      --client-origin  https://clawkie-talkie--featbrowser-voice-loop.jump.sh

The daemon prints a self-contained join URL that carries both the join
token and the rendezvous it registered with, so the phone needs no
additional config:

    Join URL: https://<client-origin>/?screen=handoff&join=<uuid>&rendezvous=<url-encoded-rendezvous-url>

Open that URL on the phone. The Handoff screen will show
`DAEMON · CONNECTING` → `DAEMON · OPEN` once the DataChannel opens.

## Control protocol on ct-control

Phone → daemon:

- `{"t":"stt.start"}` — open a fresh xAI STT WS upstream
- binary PCM16LE mono @ 16 kHz — forwarded directly to xAI
- `{"t":"stt.audio.done"}` — ends capture; triggers xAI `transcript.done`
- `{"t":"stt.cancel"}` — abort session

Daemon → phone:

- `{"t":"stt.ready"}` — xAI emitted `transcript.created`
- `{"t":"stt.partial","text":"…","is_final":bool}`
- `{"t":"stt.done","text":"…"}`
- `{"t":"stt.error","message":"…"}`
- `{"t":"stt.closed"}`

## Known gaps (intentional for this slice)

- TTS is still browser-direct-blocked in `xaiSocket.ts` — follow-up
  slice mirrors this STT transport shape for TTS.
- No TURN — STUN-only. Home NATs may need a TURN server to connect
  cellular ↔ home network.
- No auth on the rendezvous (token acts as shared secret).
- One daemon, one session, no multi-phone.
