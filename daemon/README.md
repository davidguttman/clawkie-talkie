# Clawkie-Talkie daemon

Local rendezvous daemon for Clawkie-Talkie.

For end-user Mac/Linux installation, credentials, persistence, verification, and troubleshooting, see [Install the Clawkie Talkie daemon](../docs/install-daemon.md).

The daemon subscribes to a rambly-style signaling server (SSE subscribe + HTTP
POST signal) on a stable UUID room — the `host=H` rendezvous/control room. The
daemon prints `/dashboard/#host=H` for the host dashboard; a browser landing on a
`/voice#host=H&session=S` link joins that rendezvous
room first, sends a single `rendezvous.join` message, and is told which
deterministic per-session voice room (`H:<safeSession>`) to move to.
Actual WebRTC voice/STT/TTS/OpenClaw turns happen on the per-session room, so
multiple OpenClaw sessions on the same daemon do not share a voice lane.

There is no pre-created link table, no random join id, no TTL, no claim or
revocation step. The agent constructs the URL directly from values already in the OpenClaw
turn. `session` should be the actual OpenClaw sessionId UUID when available;
only fall back to a session key when the UUID is unavailable.

## One-time install

From the repo root:

    npm install

Runtime deps: `simple-peer`, `@roamhq/wrtc`, `ws`, plus the `ffmpeg` executable on `PATH` for TTS audio decoding.

OpenClaw infer TTS currently produces an encoded audio file. The daemon uses `ffmpeg` to decode that file into PCM16LE mono before forwarding audio to the phone/WebRTC path. If `openclaw infer tts convert` succeeds but spoken replies still fail with `tts.error`, verify `command -v ffmpeg` from the same user/service environment that runs the daemon.

## Local dev

The easiest path is one command from the repo root:

    npm run dev

That starts:

- the daemon
- the Vite client on `http://localhost:5173`

For a persistent install, `.env` only needs `DAEMON_PEER_ID` — the stable
host UUID. All LLM/STT/TTS provider auth is read by `openclaw` itself from
its own configuration; the daemon does not hold provider API keys. The root
`dev:daemon` / `daemon` scripts will additionally load a repo-root `.env` if
one exists (`--env-file-if-exists=.env`).

The daemon discovers the available TTS provider/model/voice catalog by running
`openclaw infer tts providers --json` locally and the matching transcription
provider catalog by running `openclaw infer audio providers --json`. It sends
both normalized catalogs to the phone over the WebRTC DataChannel; the phone
stores only provider, model, and voice ids, never provider credentials. When
synthesizing speech, the daemon applies the selected TTS provider/model/voice
per request by passing the selected model id to `openclaw infer tts convert
--model <provider>/<model>` and the selected voice id to `--voice <voice>`.
When transcribing, the daemon applies the selected STT provider/model per
request by passing `openclaw infer audio transcribe --file <wav> --json
--model <provider>/<model>`. Clawkie Talkie must not call
`openclaw infer tts set-provider`, an equivalent global STT/audio
set-provider, or any other command that mutates OpenClaw's global provider
preferences. TTS and STT selections are independent — the user picks a TTS
provider for speech output and (separately) an STT provider for transcription.
If a configured provider exposes no model id that can be selected per request,
the client UI should leave it hidden or disabled instead of changing global
OpenClaw state as a fallback.

Rare advanced overrides (normally leave unset):

- `CT_STT_LANGUAGE` — language hint forwarded to `openclaw infer audio
  transcribe`; default lets the model auto-detect.
- `CT_THREAD_ID` — fallback Discord thread ID for transcript/debug posts when
  the daemon is invoked without a session that derives one. Not part of
  OpenClaw infer/provider config.
- `CT_CLIENT_ORIGIN` — override the client origin printed in the Join URL.
  Installed daemons default to `https://clawkietalkie.app`. Not part of
  OpenClaw infer/provider config.

## Run the daemon directly

    npm run daemon -- \
      --client-origin https://clawkietalkie.app

Optional flags:

- `--stt-language <lang>`

`DAEMON_PEER_ID` can be set as a local development override. When it is not
set, the daemon generates a fresh UUID peer id and prints a dashboard join URL
containing `#host=<peerId>`.

On startup the daemon prints:

- `Peer ID:`
- `Join URL:`

## Public URL contract

- `/` — marketing landing page placeholder. Reserved.
- `/voice/` — canonical public user-facing handoff entrypoint.
- `/voice` — clean public handoff URL used in generated links; static hosts
  resolve it to `/voice/`.
- `/dashboard/#host=H` — canonical host dashboard URL printed by the daemon. Add
  this page to the home screen for host dashboard launches. The manifest
  intentionally omits a static `start_url` so installed launches preserve the
  chosen dashboard URL/hash.
- `/dashboard/` — can recover the last browser-remembered host when available;
  without a saved host it shows the missing/bad-session state.

The agent constructs the URL directly:

    https://clawkietalkie.app/voice#host=H&session=<sessionId>&sessionKey=<sessionKey>&channel=<channel>&target=<target>&accountId=<accountId>

Hash args are preferred (so `host`, `session`, `sessionKey`, `channel`, `target`,
and `accountId` are never sent to web servers); query params are accepted for
compatibility. If a key appears in both, the hash wins. All values must be
URL-encoded. `sessionKey`, `channel`, `target`, and `accountId` should be
included whenever visible in trusted runtime context. `sessionKey` selects the
OpenClaw agent and can derive Discord reply/transcript routing; explicit
`channel` + `target` are used for mandatory assistant reply delivery and
best-effort transcript mirroring. UUID-only links may be reverse-resolved
through `openclaw sessions --json --all-agents --active 10080`; if no reply
target can be derived for a delivered voice turn, the daemon fails before
running the agent.

## Signaling

Daemon and browser share the hosted rambly-style signaling broker at
`https://api.rambly.app`. The signaling server only carries SDP/ICE;
application traffic flows over the WebRTC DataChannel directly between phone
and daemon.

## Control protocol on the DataChannel

Phone → daemon (rendezvous lane on host room `H`):

- `{"t":"rendezvous.join","sessionId":"…"}`

Daemon → phone (rendezvous lane on host room `H`):

- `{"t":"rendezvous.accept","roomId":"H:<safeSession>"}`
- `{"t":"rendezvous.error","message":"…"}` — e.g. `missing_session`,
  `too_many_voice_sessions`, `unexpected_message`.

Phone → daemon (voice lane on `H:<safeSession>`):

- `{"t":"stt.start"}` — routing is bound at rendezvous time, not per turn
- `{"t":"tts.catalog.request"}` — ask the daemon for its current normalized
  OpenClaw TTS provider/model/voice catalog
- `{"t":"stt.catalog.request"}` — ask the daemon for its current normalized
  OpenClaw audio (transcription) provider/model catalog
- `{"t":"settings.update","settings":{"tts":{"providerId":"…","model":"…","voice":"…"},"stt":{"providerId":"…","model":"…"}}}`
  — update this voice room's per-request TTS and/or STT selections by id; either
  branch may be omitted, and TTS and STT are tracked independently
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
- `{"t":"tts.catalog","catalog":{"providers":[…]}}` — catalog discovered
  from `openclaw infer tts providers --json`
- `{"t":"stt.catalog","catalog":{"providers":[…]}}` — catalog discovered
  from `openclaw infer audio providers --json`
- `{"t":"tts.start","sample_rate":24000}`
- binary PCM16LE mono TTS audio (or as a WebRTC track)
- `{"t":"tts.done"}`
- `{"t":"tts.error","message":"…"}`

## Limits

- One phone per voice room at a time.
- A daemon caps active voice rooms at `maxVoiceSessions` (default 8) to keep
  resource usage bounded. When a new voice room arrives at the cap, the daemon
  evicts the least-recently-used idle/detached room if one is safe to close.
  If every room is active, connected, or mid-turn, the new rendezvous attempt
  returns `rendezvous.error("too_many_voice_sessions")`.
