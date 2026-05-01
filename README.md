# Clawkie Talkie

Push-to-talk voice for thinking out loud into your main OpenClaw session — most often from the car.

The main use case is the drive: a feature, an essay, an app idea, or a stretch of training material you have been working on at the desk, picked back up on the highway. You switch that same OpenClaw thread to voice, use toggle talk mode to speak through the line of thought all the way through without being interrupted, and let your main agent push the work forward with full session context. Then, hours later, you reopen the thread on the laptop and read what was said.

Clawkie Talkie is not a separate assistant and not a quick-chat app. It is a voice lane into an existing OpenClaw conversation: the same session, the same thread, the same context — built for long-form prompts and long-form replies, not short back-and-forth.

You ask OpenClaw to switch to voice. It gives you a link. You open the link on your phone, press the big button to toggle talk mode, talk through the whole thought without interruption, and hear the agent answer back at length.

The original OpenClaw/Discord thread stays canonical. Your spoken direction is transcribed into that session, the agent responds in that session, and Clawkie Talkie plays the reply back to you. Everything you say and hear in the car is still there in the thread when you sit back down.

```text
feature thread ── "switch to voice" ──▶ phone link ──▶ talk next step
      ▲                                                        │
      └──────────── same OpenClaw session keeps moving ◀───────┘
```

## Install

The normal install path is agent-run. Tell your agent:

```text
Install Clawkie-Talkie for me by following
https://github.com/davidguttman/clawkie-talkie/blob/master/AGENT-INSTALL.md.

Before installing, download or clone the repo and inspect the source.
Stop and ask me if anything looks suspicious, harmful, or unclear.

The install should set up the persistent Clawkie-Talkie daemon and the
OpenClaw clawkie-voice-handoff skill so I can say "switch to voice" and
get a working handoff link.

If OpenClaw STT/TTS is not already working, help me configure OpenAI or
xAI through OpenClaw first. Do not install local Whisper or use a TTS-only
workaround unless I explicitly ask for that.

Verify the daemon/service status, logs, OpenClaw STT/TTS smoke tests, and
skill configuration before reporting success.

When finished, give me a plain English summary of what changed, what you
verified, and any blockers.
```

The install does three important things:

1. Runs the daemon as a persistent user service.
2. Generates one stable `DAEMON_PEER_ID` and keeps it in the daemon `.env`.
3. Installs the OpenClaw `clawkie-voice-handoff` skill with the same host ID.

Manual daemon setup is documented here:

- [Install the Clawkie Talkie daemon](./docs/install-daemon.md)

Agent install/upgrade/repair flow is documented here:

- [Agent install instructions](./AGENT-INSTALL.md)

## Why this exists

A lot of the most useful thinking happens away from the desk — and the most useful version of it is not a one-liner. It is a full thought, spoken straight through, while you are driving and nothing else is competing for the keyboard.

Push-to-talk is the point. You use toggle talk mode to hold the floor for as long as you need to: a paragraph, a few minutes, an entire framing for a feature or an essay. The agent does not interrupt, the phone does not interrupt, and you get to land the idea before anyone responds.

Typical sessions look like:

- drafting writing or training material out loud on a long drive, then reading the agent's response when you stop;
- exploring a new app or product idea with your main agent, with the OpenClaw session's existing context already loaded;
- thinking through a real feature or design decision in the session that already has the code, the thread, and the prior turns;
- working through review feedback or a product direction at length, instead of bouncing one-line prompts.

Clawkie Talkie is for that mode of work. It is not a quick voice chat. It is a voice lane into a real OpenClaw session for long-form steering, with the canonical written transcript waiting for you when you get back.

## The user experience

1. In an OpenClaw conversation, say:

   ```text
   switch to voice
   ```

2. OpenClaw replies with a Clawkie Talkie link for that exact session.
3. Open the link in a browser, usually on your phone.
4. Tap the main button to record.
5. Talk through the whole thought — a long prompt, a paragraph of direction, a full framing for a feature or essay. Push-to-talk means the floor stays yours until you tap again.
6. Watch the live transcript while talking.
7. Tap stop. The transcript is sent immediately.
8. OpenClaw answers in the original session, at length, with the session's full context.
9. Clawkie Talkie speaks the reply back through the browser.
10. Later, at the desk, open the original OpenClaw/Discord thread and read everything that was said.

The interface is intentionally walkie-talkie shaped: one obvious start/stop control, visible transcript while speaking, a thinking state while the agent works, and spoken playback when the reply is ready. It is built for long-form voice steering of an existing session, not for becoming a separate quick-chat app.

## What the link means

A real handoff URL looks like this:

```text
https://clawkietalkie.app/voice#host=<daemon>&session=<openclaw-session>
```

Those values are not a login token or a credential bundle. They are routing information:

- `host` — the stable local daemon ID on the user's machine.
- `session` — the OpenClaw session to continue. For external channels, this must be the exact external session key; `channel` and `target` are not URL params.

The values live in the URL hash so they are parsed by the browser locally instead of being sent to the web server as normal request parameters.

## The privacy boundary

Clawkie Talkie has a hosted browser UI, but the private work happens locally.

- The browser captures microphone audio and plays reply audio.
- The browser stores only UI settings such as provider/model/voice IDs.
- The browser does **not** receive provider API keys.
- The browser does **not** receive OpenClaw credentials.
- The local daemon talks to the local `openclaw` CLI.
- OpenClaw's existing config/auth remains the owner of LLM, STT, and TTS credentials.

The daemon is the trusted side. The browser is just the remote control and audio surface.

## Architecture

```text
Phone / browser                          User's machine
┌────────────────────────────┐          ┌────────────────────────────┐
│ Clawkie Talkie web UI      │          │ Clawkie Talkie daemon      │
│                            │          │                            │
│ - mic capture              │  WebRTC  │ - session rendezvous       │
│ - tap-to-talk control      │ ◀──────▶ │ - OpenClaw CLI calls       │
│ - live transcript display  │          │ - STT / TTS orchestration  │
│ - reply playback           │          │ - channel/thread delivery  │
└────────────────────────────┘          └────────────────────────────┘
                 │                                      │
                 │ signaling only                       │ local process calls
                 ▼                                      ▼
          https://api.rambly.app                  openclaw
```

The signaling service helps the browser and daemon find each other. The voice session itself runs over WebRTC. The daemon shells out to OpenClaw for transcription, the agent turn, reply delivery, and speech synthesis.

There is no inbound HTTP port for the daemon. It connects outbound to signaling and providers.

## Session model

There is one durable daemon per machine. Its `DAEMON_PEER_ID` is the stable rendezvous identity used in `host=...`.

Each voice handoff is then scoped by OpenClaw session:

```text
voice room = daemon host + OpenClaw session
```

That means the same daemon can support multiple OpenClaw sessions without mixing them together. A Discord thread, a webchat session, and another channel can all produce different voice rooms through the same local daemon.

The agent does not call a daemon API to mint a link. It builds the URL directly from already-known OpenClaw context: daemon host ID and session ID.

## What must already work

Clawkie Talkie depends on a working OpenClaw install for the same OS user that runs the daemon.

At minimum, that user needs:

- `openclaw` available on `PATH`;
- a working OpenClaw session/runtime;
- a configured audio transcription provider;
- a configured text-to-speech provider.

The daemon uses these commands at runtime:

```bash
openclaw infer audio transcribe --file <wav> --json
openclaw agent --session-id <session> ...
openclaw infer tts convert --text <reply> --output <file> --json
```

Provider selection is per request. Clawkie Talkie should not mutate OpenClaw's global provider preferences just because a user changes the voice settings in the browser.

## Local development

From the repo root:

```bash
npm install
npm run dev
```

That starts the daemon and the Vite client.

Common checks:

```bash
npm test
npm run typecheck
npm run build
```

Run only the daemon:

```bash
npm run daemon
```

A healthy daemon prints something like:

```text
Peer ID:  <daemon-peer-id>
Join URL: https://clawkietalkie.app/?host=<daemon-peer-id>
Waiting for phone…
```

That host-only URL is a daemon connectivity hint. A real OpenClaw voice handoff uses `/voice#host=...&session=...`.

## Troubleshooting

### The browser never connects

Check that the daemon is running and that the `host` value in the link matches the daemon's `DAEMON_PEER_ID`.

### The page says the session is bad

The handoff link is missing routing fields or was built for the wrong context. All handoff links need `host` and `session`; external channels need the exact external session key and no URL `channel`/`target`.

### Voice records but no reply comes back

Check daemon logs. Common causes are:

- `openclaw` is not on the service user's `PATH`;
- OpenClaw is not authenticated/configured for that user;
- STT provider config is missing;
- TTS provider config is missing;
- the session ID in the link does not identify a real OpenClaw session.

### Links break after restart

`DAEMON_PEER_ID` changed. It should be generated once and kept stable. The daemon `.env` and the installed OpenClaw skill must use the same value.

### It works manually but not as a service

This is usually an environment problem. The launchd/systemd service needs the same access to `node`, `npm`, and `openclaw` that your interactive shell has.

### WebRTC will not establish

Corporate networks, VPNs, proxies, and blocked UDP/TURN traffic can prevent the browser and daemon from connecting.

## Repo map

- `client/` — phone/browser UI.
- `daemon/` — local WebRTC/OpenClaw bridge.
- `openclaw/clawkie-voice-handoff/` — skill source for generating handoff links.
- `docs/install-daemon.md` — daemon install and service setup.
- `docs/voice-handoff.md` — deterministic rendezvous protocol.
- `test/` — client, daemon, protocol, and infer tests.

## Current boundaries

- macOS and Linux daemon install paths are documented.
- Windows daemon install is not documented yet.
- Clawkie Talkie is tied to OpenClaw sessions; it is not a standalone voice assistant.
- The original OpenClaw/channel thread remains the transcript source of truth.
