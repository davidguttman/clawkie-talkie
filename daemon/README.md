# Clawkie-Talkie daemon

Single-session walking skeleton. Registers with the public PeerJS broker
(peerjs.com), prints a join URL carrying the assigned peer ID, and waits
for the phone to dial in. On connect, it pipes mic PCM16 frames received
on the raw DataConnection into xAI's streaming STT WebSocket
(Authorization header auth on the daemon side), and relays
`transcript.partial` / `transcript.done` events back to the phone.

Signaling: PeerJS broker — no self-hosted rendezvous service.

## One-time install

From the repo root:

    npm install --workspaces

Runtime deps: `peerjs`, `@roamhq/wrtc` (native prebuilds for macOS /
Linux / Windows), `ws`. `peerjs` is Node-compatible when the WebRTC +
WebSocket globals are installed, which the daemon does before importing
it (see `daemon/src/peer.ts`).

## Run

    XAI_API_KEY=xai-... npm run daemon -- \
      --session-id agent:main:discord:<channelId>:<threadId> \
      --client-origin  https://clawkie-talkie--featbrowser-voice-loop.jump.sh

The daemon prints a self-contained join URL — no extra signaling config
on the phone side:

    Join URL: https://<client-origin>/?screen=handoff&host=<peerId>

Open that URL on the phone. The Handoff screen will show
`DAEMON · CONNECTING` → `DAEMON · OPEN` once the DataConnection opens.

## Control protocol on the raw DataConnection

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

The DataConnection is opened with `serialization: 'raw'` on the phone
side, so strings arrive as strings and `ArrayBuffer`s arrive as
`ArrayBuffer`s without PeerJS BinaryPack framing.

## Known gaps (intentional for this slice)

- TTS is still browser-direct-blocked in `xaiSocket.ts` — follow-up
  slice mirrors this STT transport shape for TTS.
- No TURN beyond what the PeerJS broker's STUN config provides. Home
  NATs may still need a TURN server to connect cellular ↔ home network.
- One daemon, one session, no multi-phone — the daemon rejects a second
  incoming DataConnection while the first is open.
