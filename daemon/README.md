# Clawkie-Talkie daemon

Local rendezvous daemon for Clawkie-Talkie.

For end-user Mac/Linux installation, credentials, persistence, verification, and troubleshooting, see [Install the Clawkie Talkie daemon](../docs/install-daemon.md).

The daemon subscribes to a rambly-style signaling server (SSE subscribe + HTTP
POST signal) on a stable UUID room — the `host=H` rendezvous/control room. A
browser landing on a `/voice#host=H&session=S&channel=C&target=T` link joins
that rendezvous room first, sends a single `rendezvous.join` message, and is
told which deterministic per-session voice room (`H:<safeSession>`) to move to.
Actual WebRTC voice/STT/TTS/OpenClaw turns happen on the per-session room, so
multiple OpenClaw sessions on the same daemon do not share a voice lane.

There is no pre-created link table, no random join id, no TTL, no claim or
revocation step. The agent constructs the URL directly from values already in
the OpenClaw turn.

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

The daemon reads `XAI_API_KEY` (and other config) from the process environment.
The root `dev:daemon` / `daemon` scripts will additionally load a repo-root
`.env` if one exists (`--env-file-if-exists=.env`).

## Run the daemon directly

    npm run daemon -- \
      --client-origin https://clawkietalkie.app

Optional flags:

- `--stt-language <lang>`

`DAEMON_PEER_ID` can be set as a local development override. When it is not
set, the daemon generates a fresh UUID peer id and prints a join URL containing
`#host=<peerId>`.

On startup the daemon prints:

- `Peer ID:`
- `Join URL:`

## Public URL contract

- `/` — marketing landing page placeholder. Reserved.
- `/voice` — public user-facing handoff entrypoint. Preserves both `?…` and
  `#…` when forwarding to `/voice.html`.
- `/voice.html` — voice app HTML.

The agent constructs the URL directly:

    https://clawkietalkie.app/voice#host=H&session=<sessionId>&channel=<channel>&target=<target>

Hash args are preferred (so `host`, `session`, `channel`, and `target` are
never sent to web servers); query params are accepted for compatibility. If a
key appears in both, the hash wins. All values must be URL-encoded.

## Signaling

Daemon and browser share the hosted rambly-style signaling broker at
`https://api.rambly.app`. The signaling server only carries SDP/ICE;
application traffic flows over the WebRTC DataChannel directly between phone
and daemon.

## Control protocol on the DataChannel

Phone → daemon (rendezvous lane on host room `H`):

- `{"t":"rendezvous.join","sessionId":"…","delivery":{"channel":"…","target":"…"}}`

Daemon → phone (rendezvous lane on host room `H`):

- `{"t":"rendezvous.accept","roomId":"H:<safeSession>"}`
- `{"t":"rendezvous.error","message":"…"}` — e.g. `missing_session_or_delivery`,
  `too_many_voice_sessions`, `unexpected_message`.

Phone → daemon (voice lane on `H:<safeSession>`):

- `{"t":"stt.start"}` — routing is bound at rendezvous time, not per turn
- binary PCM16LE mono @ 16 kHz — streamed to daemon-side OpenClaw infer STT
- `{"t":"stt.audio.done"}`
- `{"t":"stt.cancel"}`
- `{"t":"reply.cancel"}`

Daemon → phone (voice lane):

- `{"t":"stt.ready"}`
- `{"t":"stt.partial","text":"…","is_final":bool}`
- `{"t":"stt.done","text":"…"}`
- `{"t":"stt.error","message":"…"}`
- `{"t":"stt.closed"}`
- `{"t":"reply.start","text":"…"}`
- `{"t":"reply.done","text":"…"}`
- `{"t":"reply.error","message":"…"}`
- `{"t":"tts.start","sample_rate":24000}`
- binary PCM16LE mono TTS audio (or as a WebRTC track)
- `{"t":"tts.done"}`
- `{"t":"tts.error","message":"…"}`

## Limits

- One phone per voice room at a time.
- A daemon caps active voice rooms at `maxVoiceSessions` (default 8) to keep
  resource usage bounded. New rendezvous attempts past the cap return
  `rendezvous.error("too_many_voice_sessions")`.
