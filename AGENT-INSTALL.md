# Clawkie Talkie — Agent Install Instructions

These instructions are for an agent installing Clawkie Talkie on a user's Mac or Linux machine.

Your goals:

1. Install the Clawkie Talkie daemon from this repo.
2. Configure it with user-provided credentials and a stable daemon host ID.
3. Make it persistent after login/reboot.
4. Install the OpenClaw `clawkie-voice-handoff` skill so the user can say "switch to voice" and receive a working handoff link.
5. Verify the daemon and skill configuration before reporting success.

Do not install credentials into the browser. The daemon holds credentials locally; the browser receives only voice handoff URLs.

## Safety rules

- Do not commit `.env`, API keys, generated host IDs, LaunchAgent plists with private paths, or systemd unit files with private paths.
- Do not paste or print the xAI API key in chat/log summaries.
- Treat `DAEMON_PEER_ID` as private-ish: not a password, but do not publish it or post it in public channels.
- Use the public Clawkie Talkie client origin and the persistent daemon path; do not use local development shortcuts for an end-user install.
- Do not start/stop unrelated services.
- If the user has not provided an xAI API key or OpenClaw is not installed/configured, stop and report the missing prerequisite.

## Source

Public GitHub repo: `davidguttman/clawkietalkie`

## Fetch and inspect

1. Download or clone the repo into a durable source folder such as `~/src/clawkie-talkie`.
2. Inspect the repo before installing. Expected items include:
   - Node/npm project files
   - TypeScript daemon under `daemon/src/`
   - browser client under `client/`
   - OpenClaw skill under `openclaw/clawkie-voice-handoff/SKILL.md`
   - docs under `docs/`
3. Suspicious items to stop on:
   - unexpected credential collection beyond `.env` / user-provided API key
   - unexpected remote shell execution
   - install-time scripts that mutate global state without user consent
   - code that exfiltrates `.env`, OpenClaw config, browser cookies, or arbitrary files

## Prerequisites to verify

From the user's shell account that will run the daemon:

```bash
node -v
npm -v
command -v openclaw
openclaw status
```

Use Node 22 LTS or newer when possible. If `openclaw` is missing or not configured, stop and tell the user OpenClaw must be installed/configured first.

## Install dependencies

From the repo root:

```bash
npm install
```

`@roamhq/wrtc` normally installs a prebuilt native package for supported macOS/Linux architectures. If it fails, install platform build tools and retry. See `docs/install-daemon.md` for platform-specific notes.

## Configure `.env`

Create the repo-root `.env` file from the example:

```bash
cp .env.example .env
chmod 600 .env
```

Set these values:

```env
XAI_API_KEY=<user-provided-xai-key>
DAEMON_PEER_ID=<generated-stable-uuid>
CT_CLIENT_ORIGIN=https://clawkietalkie.app
```

Generate the stable host ID once:

```bash
node -e "console.log(require('node:crypto').randomUUID())"
```

Put that UUID in `.env` as `DAEMON_PEER_ID`. Do not regenerate it on later updates. The OpenClaw handoff skill and browser links depend on this value staying stable.

Optional `.env` values:

```env
SIGNAL_SERVER=
CT_STT_LANGUAGE=en
CT_THREAD_ID=
```

## Manual daemon verification

Run once from the repo root:

```bash
npm run daemon
```

Success looks like:

```text
Peer ID:  <DAEMON_PEER_ID>
Join URL: https://clawkietalkie.app/?host=<DAEMON_PEER_ID>
Waiting for phone…
```

Verify the printed `Peer ID` matches `.env` exactly. Stop the manual run with `Ctrl-C` before installing the persistent service.

## Install persistence

Use `docs/install-daemon.md` for the exact launchd/systemd examples.

Required verification after persistence is installed:

- macOS: `launchctl print gui/$(id -u)/app.clawkietalkie.daemon`
- Linux: `systemctl --user status clawkie-talkie.service`
- Logs include `Peer ID: <DAEMON_PEER_ID>` or `subscribed to rendezvous room as <DAEMON_PEER_ID>`
- The service restarts cleanly after a manual restart command.

## Install the OpenClaw skill

The skill source is:

```text
openclaw/clawkie-voice-handoff/SKILL.md
```

Install it into the OpenClaw runtime skills directory for this user. In a standard OpenClaw workspace, this is usually:

```text
~/clawd/skills/clawkie-voice-handoff/SKILL.md
```

If this path does not exist, discover the active skills directory from the current OpenClaw runtime/session context. Do not guess. If you cannot determine the runtime skill path, stop and report that blocker.

Create the destination directory and copy the skill:

```bash
mkdir -p ~/clawd/skills/clawkie-voice-handoff
cp openclaw/clawkie-voice-handoff/SKILL.md ~/clawd/skills/clawkie-voice-handoff/SKILL.md
```

Then patch the installed copy only:

- `INSTALLED = false` → `INSTALLED = true`
- `CLAWKIE_DAEMON_HOST_ID = "<CONFIGURE_DAEMON_PEER_ID>"` → the exact `DAEMON_PEER_ID` from `.env`
- `INSTALL_DATE = ""` → today's date in `YYYY-MM-DD` format

Do not patch the source copy in the repo with the user's host ID.

## Verify the skill install

Before claiming success:

1. Confirm the installed skill exists at the runtime path.
2. Confirm the installed skill no longer contains `<CONFIGURE_DAEMON_PEER_ID>`.
3. Confirm the installed skill says `INSTALLED = true`.
4. Confirm the installed skill's `CLAWKIE_DAEMON_HOST_ID` matches the daemon `.env` `DAEMON_PEER_ID`.
5. Construct a dry-run handoff URL using the same algorithm as the skill:

```js
const params = new URLSearchParams();
params.set('host', daemonPeerId);
params.set('session', 'agent:main:discord:channel:EXAMPLE');
params.set('channel', 'discord');
params.set('target', 'channel:EXAMPLE');
console.log(`https://clawkietalkie.app/voice#${params.toString()}`);
```

The dry-run URL must include `host`, `session`, `channel`, and `target` in the hash.

## Required final report

Report only non-secret facts:

- Daemon source path
- Whether dependencies installed
- Whether `.env` exists and contains required keys, without printing key values
- Whether `DAEMON_PEER_ID` is stable/configured, without printing it unless the user explicitly asks
- Persistence method installed: launchd or systemd user service
- Service status/log evidence
- Skill destination path
- Skill configured: yes/no
- Verification commands run
- Any blockers

Do not report the xAI API key. Avoid posting the daemon host ID into public/shared chat unless necessary.
