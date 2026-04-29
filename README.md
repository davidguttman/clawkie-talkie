# Clawkie Talkie

Push-to-talk voice for moving an OpenClaw session forward when you are away from the keyboard.

The main use case is simple: you have a feature or writing task already in motion, then you get in the car. Instead of letting the session stall until you are back at your desk, you switch that same OpenClaw thread to voice, give direction from your phone, and let the agent keep pushing.

Clawkie Talkie is not a separate assistant. It is a voice lane into an existing OpenClaw conversation: the same session, the same thread, the same context, with a phone-friendly interface for the moments when typing is the wrong tool.

You ask OpenClaw to switch to voice. It gives you a link. You open the link on your phone, tap the big button, talk through the next decision, stop, and hear the agent answer back.

The original OpenClaw/Discord thread stays canonical. Your spoken direction is transcribed into that session, the agent responds in that session, and Clawkie Talkie plays the reply back to you.

```text
feature thread ── "switch to voice" ──▶ phone link ──▶ talk next step
      ▲                                                        │
      └──────────── same OpenClaw session keeps moving ◀───────┘
```

## Why this exists

OpenClaw is often running somewhere you are not: at your desk, in a Discord thread, in a browser workflow, in the middle of a task. Sometimes the next useful contribution is not a carefully typed prompt; it is a quick piece of direction:

- “keep going, but make the README speak to the car use case”;
- “ship the smaller version first, then open a follow-up”;
- “ask Codex to try option B and report back”;
- “rewrite that section in plain English, then commit it.”

Clawkie Talkie is for those moments: walking out the door, driving, cooking, pacing, or otherwise away from the workstation, while the work still has momentum.

It gives you a voice interface for steering the existing session, especially for writing, product direction, review feedback, and feature work that can keep advancing without you typing every turn.

## The user experience

1. In an OpenClaw conversation, say:

   ```text
   switch to voice
   ```

2. OpenClaw replies with a Clawkie Talkie link for that exact session.
3. Open the link in a browser, usually on your phone.
4. Tap the main button to record.
5. Say the next piece of direction: what to write, what to change, what to test, what to ask the implementation agent, or what decision to make.
6. Watch the live transcript while talking.
7. Tap stop. The transcript is sent immediately.
8. OpenClaw answers in the original session.
9. Clawkie Talkie speaks the reply back through the browser.

The interface is intentionally walkie-talkie shaped: one obvious start/stop control, visible transcript while speaking, a thinking state while the agent works, and spoken playback when the reply is ready. It is built for steering work in short bursts, not for becoming a separate chat app.

## What the link means

A real handoff URL looks like this:

```text
https://clawkietalkie.app/voice#host=<daemon>&session=<openclaw-session>&channel=<channel>&target=<target>
```

Those values are not a login token or a credential bundle. They are routing information:

- `host` — the stable local daemon ID on the user's machine.
- `session` — the OpenClaw session to continue.
- `channel` — where the original conversation lives.
- `target` — where transcript/reply mirroring should be delivered, when the source is an external channel like Discord.

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

The agent does not call a daemon API to mint a link. It builds the URL directly from already-known OpenClaw context: daemon host ID, session ID, channel, and target.

## Install

The normal install path is agent-run. Tell your agent:

```text
Install Clawkie Talkie by following https://github.com/davidguttman/clawkie-talkie/blob/master/AGENT-INSTALL.md. Inspect the downloaded files first. Stop if anything looks suspicious. When done, report whether the daemon is running, whether OpenClaw STT/TTS smoke tests passed, and whether the voice handoff skill is installed.
```

The install does three important things:

1. Runs the daemon as a persistent user service.
2. Generates one stable `DAEMON_PEER_ID` and keeps it in the daemon `.env`.
3. Installs the OpenClaw `clawkie-voice-handoff` skill with the same host ID.

Manual daemon setup is documented here:

- [Install the Clawkie Talkie daemon](./docs/install-daemon.md)

Agent install/upgrade/repair flow is documented here:

- [Agent install instructions](./AGENT-INSTALL.md)

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
openclaw infer tts convert --text <reply> --output <file> --json --local
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

That host-only URL is a daemon connectivity hint. A real OpenClaw voice handoff uses `/voice#host=...&session=...&channel=...`.

## Troubleshooting

### The browser never connects

Check that the daemon is running and that the `host` value in the link matches the daemon's `DAEMON_PEER_ID`.

### The page says the session is bad

The handoff link is missing routing fields or was built for the wrong context. External channels need `host`, `session`, `channel`, and `target`. Webchat/internal links can omit `target`.

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
