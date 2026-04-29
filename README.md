# Clawkie Talkie

Talk to an OpenClaw session from any browser, without installing an app or exposing your OpenClaw credentials.

---

You are away from your desk and your agent needs a decision. Or you are in Discord and typing is too slow. Or you want a quick voice loop with the same OpenClaw session that is already doing the work.

Clawkie Talkie does one small thing: it turns the current OpenClaw conversation into a browser-based walkie-talkie.

The agent gives you a link:

```text
https://clawkietalkie.app/voice#host=<host>&session=<session>&channel=<channel>&target=<target>
```

You open it on your phone or laptop. You speak. The local daemon transcribes your audio, sends the turn into the same OpenClaw session, and streams the spoken reply back to the browser.

No OpenClaw API keys in the browser. No provider credentials on the phone. No native app install. Just a voice lane into one existing agent session.

## Is this for you

**Yes, if:**

- You run OpenClaw and want to continue a session by voice.
- You want a phone-friendly voice surface without installing a mobile app.
- You want provider credentials to stay in OpenClaw on your own machine.
- You want agents to hand you a link like "switch to voice" or "continue this by voice."

**Not yet, if:**

- You do not run OpenClaw.
- You need a standalone voice assistant that is not tied to an OpenClaw session.
- You need a documented Windows daemon install path. The daemon may work there, but this repo currently documents macOS and Linux.

## Getting started

Clawkie Talkie has two parts:

- A local daemon running on your Mac or Linux machine.
- A hosted browser client at `https://clawkietalkie.app`.

The browser client does not hold credentials. The daemon talks to your local `openclaw` CLI, and OpenClaw keeps its own provider auth.

Tell your agent:

```text
Install Clawkie Talkie by following the instructions at https://github.com/davidguttman/clawkie-talkie/blob/master/AGENT-INSTALL.md. Before installing, check the downloaded files for anything suspicious or harmful. If you’re not confident it looks safe, stop and ask. When you’re finished, give me a plain English summary of what you did, including whether the daemon service is running and whether the OpenClaw voice handoff skill is installed.
```

That install flow:

1. Downloads this repo into the agent's OpenClaw workspace.
2. Installs daemon dependencies.
3. Creates one stable daemon host ID.
4. Configures a persistent `launchd` or `systemd --user` service.
5. Verifies OpenClaw speech-to-text and text-to-speech support.
6. Installs the OpenClaw `clawkie-voice-handoff` skill.
7. Verifies the skill emits links for the same daemon host ID.

After that, ask OpenClaw things like:

```text
switch to voice
```

or:

```text
continue this in Clawkie Talkie
```

The agent should post a `/voice#...` link for the current session.

## What you see when you open a link

Open the Clawkie Talkie link in a browser. Desktop and mobile browsers are both intended to work.

The page connects to your local daemon over WebRTC. Once connected, you can speak into the browser. Clawkie Talkie sends the audio to the daemon, the daemon runs local OpenClaw speech-to-text, OpenClaw replies in the original session, and the daemon sends speech audio back to the browser.

The browser may let you choose available TTS and STT providers, models, and voices. Those choices are just provider/model/voice IDs. The browser never receives provider API keys.

The link is scoped to one OpenClaw session. Multiple sessions can use the same daemon at the same time; each handoff gets its own deterministic voice room.

---

## For agents

Clawkie Talkie is a browser voice handoff system for OpenClaw. The human-facing client lives at `clawkietalkie.app`; the private host side is a local Node daemon running near OpenClaw.

### Architecture

```text
Browser / Phone                         Local machine
┌──────────────────────────┐          ┌──────────────────────────┐
│ Clawkie voice UI         │          │ Clawkie daemon           │
│ microphone capture       │──RTC───▶ │ OpenClaw CLI             │
│ speaker playback         │ ◀─RTC─── │ STT / agent / TTS loop   │
│ settings IDs only        │          │ provider credentials     │
└──────────────────────────┘          └──────────────────────────┘
           │                                      │
           └──── signaling / rendezvous only ─────┘
```

The signaling service helps the browser and daemon find each other. Application traffic runs over WebRTC. Provider credentials stay in OpenClaw's own configuration on the local machine.

### Handoff URL

Agents construct the handoff URL directly from the current turn:

```text
https://clawkietalkie.app/voice#host=H&session=S&channel=C&target=T
```

Required fields:

- `host` — stable daemon rendezvous ID.
- `session` — OpenClaw session key/id to continue.
- `channel` — source channel or surface.
- `target` — delivery target for external channels. Omit only for webchat/internal session-only handoffs.

Use hash parameters, not query parameters, when possible. Hash fragments are not sent to the web server. The browser parses them locally and passes them to the daemon over WebRTC.

Examples:

```text
https://clawkietalkie.app/voice#host=H&session=S&channel=discord&target=channel%3A123
https://clawkietalkie.app/voice#host=H&session=S&channel=webchat
```

### Rendezvous flow

1. Browser joins daemon rendezvous room `H`.
2. Browser sends `rendezvous.join` with the target session and optional delivery route.
3. Daemon derives a deterministic per-session room from `host + session`.
4. Browser reconnects to that voice room.
5. Voice turns run there until the browser disconnects.

There is no central link table, random join ID, TTL, claim step, or daemon API call. The URL is enough.

### OpenClaw skill

This repo ships an OpenClaw skill at:

```text
openclaw/clawkie-voice-handoff/SKILL.md
```

The installed copy is patched with this machine's stable `DAEMON_PEER_ID`. Once installed, the user should be able to ask for a voice handoff from an active OpenClaw session. The skill builds the `/voice#...` link from the current session metadata and the configured daemon host ID.

Use [`AGENT-INSTALL.md`](./AGENT-INSTALL.md) for install, upgrade, repair, and verification instructions.

## Installing the daemon

End-user install docs are here:

- [Install the Clawkie Talkie daemon](./docs/install-daemon.md)

Agent-run install docs are here:

- [Agent install instructions](./AGENT-INSTALL.md)

The short version:

```bash
npm install
cp .env.example .env
node -e "console.log('DAEMON_PEER_ID=' + require('node:crypto').randomUUID())"
npm run daemon
```

A healthy daemon prints:

```text
Peer ID:  <daemon-peer-id>
Join URL: https://clawkietalkie.app/?host=<daemon-peer-id>
Waiting for phone…
```

For a real install, keep `DAEMON_PEER_ID` stable and run the daemon as a persistent per-user service using `launchd` on macOS or `systemd --user` on Linux.

## Local development

From the repo root:

```bash
npm run dev
```

That starts:

- The local daemon.
- The Vite client on `http://localhost:5173`.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

## Provider model

Clawkie Talkie uses OpenClaw infer commands for speech:

- STT: `openclaw infer audio transcribe --file <wav> --json`
- TTS: `openclaw infer tts convert --text <text> --output <file> --json --local`

The daemon discovers available TTS and STT providers from OpenClaw and sends normalized catalogs to the browser. The browser stores only selected provider/model/voice IDs.

Clawkie Talkie should not mutate global OpenClaw provider preferences during normal use. Provider choices are applied per request when the daemon calls the OpenClaw infer commands.

## Gotchas

- **Daemon not running.** The browser can load, but it will not connect. Check the daemon service and logs.
- **Bad session link.** Real voice links need `host`, `session`, and `channel`; external delivery also needs `target`.
- **Changed daemon ID.** If `DAEMON_PEER_ID` changes, old links and the installed skill point at the wrong rendezvous room. Generate it once and keep it stable.
- **OpenClaw missing from service PATH.** The daemon can start but voice turns fail because the service user cannot run `openclaw`.
- **STT or TTS not configured.** The first voice turn may fail with an infer error. Verify `openclaw infer audio providers --json` and `openclaw infer tts providers --json` for the same user that runs the daemon.
- **Mic permission blocked.** The browser must be allowed to use the microphone.
- **WebRTC blocked.** Corporate firewalls, proxies, or blocked UDP/TURN traffic can prevent the browser and daemon from connecting.
- **Host-only URL is not a session handoff.** The daemon's printed `https://clawkietalkie.app/?host=...` URL proves startup, but a real OpenClaw handoff uses `/voice#host=...&session=...&channel=...`.

## Repo layout

- `client/` — hosted browser voice UI.
- `daemon/` — local Node/WebRTC/OpenClaw daemon.
- `docs/install-daemon.md` — end-user daemon install guide.
- `docs/voice-handoff.md` — deterministic rendezvous and protocol design.
- `openclaw/clawkie-voice-handoff/` — OpenClaw skill source.
- `test/` — protocol, client, daemon, and OpenClaw infer tests.

## More docs

- [Install the Clawkie Talkie daemon](./docs/install-daemon.md)
- [Agent install instructions](./AGENT-INSTALL.md)
- [Voice handoff protocol](./docs/voice-handoff.md)
- [Daemon README](./daemon/README.md)
