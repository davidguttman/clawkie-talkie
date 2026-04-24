# Clawkie-Talkie daemon

Single-session daemon for Clawkie-Talkie.

It registers with the default public PeerJS signaling server, prints a join URL
carrying the assigned peer ID, accepts one phone WebRTC DataConnection at a
time, streams PCM16 mic audio to xAI STT, runs the reply loop, and streams TTS
audio back to the phone. The daemon does not run a local HTTP signaling server.

## One-time install

From the repo root:

    npm install

Runtime deps: `peerjs`, `@roamhq/wrtc`, `ws`.

## Local dev

The easiest path is one command from the repo root:

    npm run dev

That starts:

- the daemon
- the Vite client on `http://localhost:5173`

The daemon loads `XAI_API_KEY` from the repo-root `.env` via the root
`dev:daemon` / `daemon` scripts, so local dev does not need a manual `export`.
Copy `.env.example` to `.env` and fill in your key.

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

Both the daemon and browser use PeerJS defaults, which means the public PeerJS
broker is used only for signaling. There is no local PeerServer, no `/peerjs`
proxy, and no daemon HTTP listener. Application traffic between the phone and
daemon goes over the WebRTC DataConnection.

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
- no TURN server yet
