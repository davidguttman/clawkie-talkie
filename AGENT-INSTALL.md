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
- Before asking the user for an xAI key, check the local OpenClaw configuration and auth profiles for an existing configured xAI key. A missing `XAI_API_KEY` shell environment variable is **not** enough reason to ask the user to paste a key.
- Treat `DAEMON_PEER_ID` as private-ish: not a password, but do not publish it or post it in public channels.
- Use the public Clawkie Talkie client origin and the persistent daemon path; do not use local development shortcuts for an end-user install.
- Do not start/stop unrelated services.
- If OpenClaw is not installed/configured, stop and report the missing prerequisite. If no usable xAI key exists after checking local OpenClaw config/auth profiles and any user-designated secret source, ask for a safe secret handoff path; do not ask the user to paste the key into a public/shared chat.

## Source

Public GitHub repo: `davidguttman/clawkietalkie`

## Fetch and inspect

1. Identify the installing agent's own OpenClaw workspace directory from the current runtime/session context. Do **not** invent a separate home-directory workspace and do **not** copy any path from this repository author's machine. If the active OpenClaw workspace cannot be determined, stop and ask the user.

   Download the GitHub source ZIP into that workspace, for example under `<OPENCLAW_WORKSPACE>/external/clawkie-talkie`:

   ```bash
   OPENCLAW_WORKSPACE="/absolute/path/to/this-openclaw-workspace"
   CLAWKIE_SOURCE_DIR="$OPENCLAW_WORKSPACE/external/clawkie-talkie"

   mkdir -p "$(dirname "$CLAWKIE_SOURCE_DIR")"
   cd "$(dirname "$CLAWKIE_SOURCE_DIR")"
   curl -L -o clawkie-talkie.zip \
     https://github.com/davidguttman/clawkietalkie/archive/HEAD.zip
   unzip -q clawkie-talkie.zip
   extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkietalkie-*' | head -n 1)
   rm -rf "$CLAWKIE_SOURCE_DIR"
   mv "$extracted_dir" "$CLAWKIE_SOURCE_DIR"
   rm clawkie-talkie.zip
   cd "$CLAWKIE_SOURCE_DIR"
   ```
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

You — the installer — generate one stable daemon host UUID for this machine. The same UUID goes into the daemon's `.env` as `DAEMON_PEER_ID` and into the runtime-installed handoff skill as `CLAWKIE_DAEMON_HOST_ID`. This works the same way LobsterLink stores its discovered Chrome extension ID into the LobsterLink skill: a value generated/discovered at install time, written into the runtime skill, and used directly thereafter. The user does not need to know or configure this UUID.

Generate it once:

```bash
node -e "console.log(require('node:crypto').randomUUID())"
```

Set these values in `.env`:

```env
XAI_API_KEY=<xai-key-from-local-openclaw-config-or-user-approved-secret-source>
DAEMON_PEER_ID=<installer-generated-uuid>
```

Credential source order for `XAI_API_KEY`:

1. Preserve an existing repo-root `.env` value if this is an update and it is already present.
2. Check the local OpenClaw config/auth profile for an existing xAI API key. Use `openclaw config file`/`openclaw config get ...` or the runtime's config tooling to find the active config; if the value is a SecretRef, resolve it through the configured local secret provider. Copy the key locally into `.env` without printing it.
3. Check only user-designated local secret sources, if the user already named one.
4. Only then ask the user for a safe way to provide the key. Do **not** tell them to paste it into chat.

When reporting a blocker, be specific: say whether the key was absent from OpenClaw config, present but unresolved, or unavailable because the secret provider was locked/unconfigured. Do not summarize that as merely "no key in the shell environment."

Do not regenerate the UUID on later updates — keep it stable so existing handoff links and the installed skill remain valid.

The installed daemon defaults the client origin to `https://clawkietalkie.app`, so `CT_CLIENT_ORIGIN` is not required. Only set it as an override if the user explicitly wants to point at a non-default client deployment. The signaling server is also non-configurable for end-user installs.

Optional `.env` values:

```env
CT_STT_LANGUAGE=en
CT_THREAD_ID=
# Override the default client origin (https://clawkietalkie.app):
# CT_CLIENT_ORIGIN=
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

Install it into the runtime skills directory for **this OpenClaw install's workspace**. Use the workspace path from the current runtime/session context; do not hardcode the maintainer's workspace path or any other user-specific path.

If the runtime exposes a specific skills directory, use it. Otherwise use `<OPENCLAW_WORKSPACE>/skills`. If you cannot determine the active workspace or skills directory, stop and report that blocker.

Create the destination directory and copy the skill:

```bash
: "${OPENCLAW_WORKSPACE:?set this to the installing agent's OpenClaw workspace directory}"
OPENCLAW_SKILLS_DIR="${OPENCLAW_SKILLS_DIR:-$OPENCLAW_WORKSPACE/skills}"
CLAWKIE_SKILL_DIR="$OPENCLAW_SKILLS_DIR/clawkie-voice-handoff"

mkdir -p "$CLAWKIE_SKILL_DIR"
cp openclaw/clawkie-voice-handoff/SKILL.md "$CLAWKIE_SKILL_DIR/SKILL.md"
```

Then patch the installed copy only (mirroring how the LobsterLink installer writes its discovered extension ID into the LobsterLink runtime skill):

- `INSTALLED = false` → `INSTALLED = true`
- `Install date:` → today's date in `YYYY-MM-DD` format
- `CLAWKIE_DAEMON_HOST_ID = `<CONFIGURE_DAEMON_PEER_ID>`` → the exact `DAEMON_PEER_ID` from `.env`

Do not patch the source copy in the repo with the real host ID.

Invariant: the daemon `.env` `DAEMON_PEER_ID` must equal the installed skill's `CLAWKIE_DAEMON_HOST_ID`. If they ever diverge, the skill emits handoff links that point at the wrong rendezvous room.

## Verify the skill install

Before claiming success:

A robust check should parse the configured host line instead of grepping the entire file for placeholder words. For example:

```bash
configured_host=$(awk -F'= ' '/^- CLAWKIE_DAEMON_HOST_ID = / {gsub(/`/, "", $2); print $2; exit}' "$CLAWKIE_SKILL_DIR/SKILL.md")
test "$configured_host" = "$DAEMON_PEER_ID"
```

1. Confirm the installed skill exists at the runtime path.
2. Confirm the installed skill says `INSTALLED = true`.
3. Confirm the installed skill's **configuration bullet** for `CLAWKIE_DAEMON_HOST_ID` was patched from the repo placeholder to the daemon `.env` `DAEMON_PEER_ID`. Do not fail the install just because explanatory prose elsewhere mentions placeholders.
4. Confirm no active config line remains exactly `CLAWKIE_DAEMON_HOST_ID = `<CONFIGURE_DAEMON_PEER_ID>``.
5. Confirm the installed skill's `CLAWKIE_DAEMON_HOST_ID` matches the daemon `.env` `DAEMON_PEER_ID`.
6. Construct a dry-run handoff URL using the same algorithm as the skill:

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
