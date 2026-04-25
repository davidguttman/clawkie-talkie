# Clawkie-Talkie daemon

Single-session daemon for Clawkie-Talkie.

It subscribes to a rambly-style signaling server (SSE subscribe + HTTP POST
signal) under a UUID token, prints a join URL carrying that token, accepts one
phone WebRTC DataChannel at a time (over `simple-peer` + `@roamhq/wrtc`),
streams PCM16 mic audio to xAI STT, runs the reply loop, and streams TTS audio
back to the phone.

## One-time install

From the repo root:

    npm install

Runtime deps: `simple-peer`, `@roamhq/wrtc`, `ws`.

## Local dev

The easiest path is one command from the repo root:

    npm run dev

That starts:

- the daemon
- the Vite client on `http://localhost:5173`

The daemon reads `XAI_API_KEY` (and other config) from the process
environment. The root `dev:daemon` / `daemon` scripts will additionally
load a repo-root `.env` if one exists (`--env-file-if-exists=.env`),
so local dev can either `export XAI_API_KEY=...` or copy
`.env.example` to `.env`. A missing `.env` is not an error.

## Run the daemon directly

    npm run daemon -- \
      --session-id agent:main:discord:<channelId>:<threadId> \
      --client-origin https://clawkie-talkie.davidguttman.jump.sh

Optional flags:

- `--peer-id <id>`
- `--stt-language <lang>`

On startup the daemon prints:

- `Session:`
- `Peer ID:`
- `Join URL:`

The join URL is a handoff link like:

    https://<client-origin>/?screen=handoff&host=<peerId>&session=<sessionId>

## Signaling

Daemon and browser share the hosted rambly-style signaling broker. Default is
`https://api.rambly.app`; override with `SIGNAL_SERVER` (daemon) and
`VITE_SIGNAL_SERVER` (client). This repo intentionally does not include or
start a local signaling server.

The signaling server only carries SDP/ICE — application traffic flows over
the WebRTC DataChannel directly between phone and daemon.

## Control protocol on the raw DataConnection

Phone → daemon:

- `{"t":"stt.start"}` — open a fresh xAI STT upstream
- binary PCM16LE mono @ 16 kHz — forwarded directly to xAI
- `{"t":"stt.audio.done"}` — end capture and wait for final transcript
- `{"t":"stt.cancel"}` — abort session
- `{"t":"reply.cancel"}` — cancel chat/TTS for the active turn

Daemon → phone:

- `{"t":"stt.ready"}`
- `{"t":"stt.partial","text":"…","is_final":bool}`
- `{"t":"stt.done","text":"…"}`
- `{"t":"stt.error","message":"…"}`
- `{"t":"stt.closed"}`
- `{"t":"reply.start","transcript":"…"}`
- `{"t":"reply.done","text":"…"}`
- `{"t":"reply.error","message":"…"}`
- `{"t":"tts.start","sampleRate":24000}`
- binary PCM16LE mono TTS audio
- `{"t":"tts.done"}`
- `{"t":"tts.error","message":"…"}`

## Known gaps

- one daemon, one phone — a second phone is rejected while one session is open
- one shared TURN server, matching the rambly CLI client default
