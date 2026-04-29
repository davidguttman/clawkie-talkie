# Clawkie Talkie — Agent Install Instructions

These instructions are for an agent installing, reinstalling, or upgrading Clawkie Talkie on a user's Mac or Linux machine.

Your goals:

1. Install or upgrade the Clawkie Talkie daemon from this repo.
2. Configure it with a stable daemon host ID.
3. Make it persistent after login/reboot.
4. Install the OpenClaw `clawkie-voice-handoff` skill so the user can say "switch to voice" and receive a working handoff link.
5. Verify the daemon and skill configuration before reporting success.

Do not install credentials into the browser. The browser receives only voice handoff URLs. All LLM/STT/TTS provider auth lives in OpenClaw's own configuration; the daemon does not read or hold provider API keys.

## Hard prerequisite: OpenClaw 2026.4.25+

Clawkie Talkie requires OpenClaw **2026.4.25 or newer** for the same OS user that will run the daemon.

Before installing, reinstalling, or upgrading Clawkie Talkie:

1. Check the user's OpenClaw version.
2. If OpenClaw is missing, unconfigured, or older than `2026.4.25`, stop the Clawkie Talkie install.
3. Help the user update or repair OpenClaw first.
4. Resume Clawkie Talkie only after `openclaw status` works for OpenClaw 2026.4.25+.

Do not treat an OpenClaw update as optional and do not leave it as a task for the user to figure out manually.

## Safety rules

- Do not commit `.env`, generated host IDs, LaunchAgent plists with private paths, or systemd unit files with private paths.
- Do not paste or print provider API keys (OpenClaw config) in chat/log summaries.
- Treat `DAEMON_PEER_ID` as private-ish: not a password, but do not publish it or post it in public channels.
- Use the public Clawkie Talkie client origin and the persistent daemon path; do not use local development shortcuts for an end-user install.
- Do not start/stop unrelated services.

## Source

Public GitHub repo: `davidguttman/clawkie-talkie`

## Choose install mode first

Before fetching or replacing files, decide which mode applies:

- **Fresh install:** no existing Clawkie Talkie source directory, daemon `.env`, persistence service, or installed OpenClaw handoff skill exists.
- **Upgrade:** Clawkie Talkie is already installed and should keep the same `.env`, `DAEMON_PEER_ID`, persistence method, and installed skill configuration while code/docs are refreshed.
- **Reinstall/repair:** an install exists but source files or dependencies are broken. Treat it like an upgrade: preserve secrets and IDs first, then replace code.

For upgrades/reinstalls, do **not** delete the existing source directory until you have preserved and verified:

- repo-root `.env`
- the existing `DAEMON_PEER_ID`
- the installed OpenClaw skill's `CLAWKIE_DAEMON_HOST_ID`
- the active persistence mechanism (`launchd` or `systemd --user`)

The preserved daemon `DAEMON_PEER_ID` and installed skill `CLAWKIE_DAEMON_HOST_ID` must stay identical after the upgrade.

## Fetch and inspect

1. Identify the installing agent's own OpenClaw workspace directory from the current runtime/session context. Do **not** invent a separate home-directory workspace and do **not** copy any path from this repository author's machine. If the active OpenClaw workspace cannot be determined, stop and ask the user.

   For a fresh install, download the GitHub source ZIP into that workspace, for example under `<OPENCLAW_WORKSPACE>/external/clawkie-talkie`. Refuse to overwrite an existing target in this mode:

   ```bash
   OPENCLAW_WORKSPACE="/absolute/path/to/this-openclaw-workspace"
   CLAWKIE_SOURCE_DIR="$OPENCLAW_WORKSPACE/external/clawkie-talkie"

   if [ -e "$CLAWKIE_SOURCE_DIR" ]; then
     echo "$CLAWKIE_SOURCE_DIR already exists; use the upgrade/reinstall flow instead of overwriting it" >&2
     exit 1
   fi

   workdir=$(mktemp -d)
   trap 'rm -rf "$workdir"' EXIT
   cd "$workdir"
   curl -L -o clawkie-talkie.zip \
     https://github.com/davidguttman/clawkie-talkie/archive/HEAD.zip
   unzip -q clawkie-talkie.zip
   extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkie-talkie-*' | head -n 1)
   mkdir -p "$(dirname "$CLAWKIE_SOURCE_DIR")"
   mv "$extracted_dir" "$CLAWKIE_SOURCE_DIR"
   cd "$CLAWKIE_SOURCE_DIR"
   ```
2. Inspect the repo before installing. Expected items include:
   - Node/npm project files
   - TypeScript daemon under `daemon/src/`
   - browser client under `client/`
   - OpenClaw skill under `openclaw/clawkie-voice-handoff/SKILL.md`
   - docs under `docs/`
3. Suspicious items to stop on:
   - unexpected credential collection in `.env` (it should only carry `DAEMON_PEER_ID` and optional non-secret toggles)
   - unexpected remote shell execution
   - install-time scripts that mutate global state without user consent
   - code that exfiltrates `.env`, OpenClaw config, browser cookies, or arbitrary files

## Upgrade or reinstall/repair an existing install

Use this flow when `CLAWKIE_SOURCE_DIR` already exists, the daemon has run before, or the OpenClaw handoff skill is already installed.

1. Locate the current source directory. Prefer the configured service command/path if it exists; otherwise use the known install path under the OpenClaw workspace.
2. Preserve current local configuration before touching source files:

   ```bash
   : "${CLAWKIE_SOURCE_DIR:?set to existing Clawkie Talkie source directory}"
   cd "$CLAWKIE_SOURCE_DIR"

   test -f .env || { echo "missing .env; stop and ask before reinstalling" >&2; exit 1; }
   chmod 600 .env
   DAEMON_PEER_ID=$(awk -F= '/^DAEMON_PEER_ID=/{print $2; exit}' .env)
   test -n "$DAEMON_PEER_ID" || { echo "missing DAEMON_PEER_ID in .env; stop before changing files" >&2; exit 1; }
   ```

   Do not generate a new daemon peer ID unless the user explicitly asks to create a new identity.

3. Stop only the Clawkie Talkie user service while replacing files:

   - macOS: unload/stop the `app.clawkietalkie.daemon` LaunchAgent for the current user.
   - Linux: `systemctl --user stop clawkie-talkie.service`.

   Do not stop unrelated OpenClaw, browser, Docker, or system services.

4. Refresh the source safely:

   - If the source directory is a git checkout and has no relevant local changes, use `git fetch --prune` followed by a fast-forward update to the desired branch/revision.
   - If the source came from a ZIP or the git state is unclear, download a fresh ZIP into a temporary directory and copy it over the existing source while preserving local runtime files:

   ```bash
   : "${CLAWKIE_SOURCE_DIR:?set to existing Clawkie Talkie source directory}"
   workdir=$(mktemp -d)
   trap 'rm -rf "$workdir"' EXIT
   cd "$workdir"

   curl -L -o clawkie-talkie.zip \
     https://github.com/davidguttman/clawkie-talkie/archive/HEAD.zip
   unzip -q clawkie-talkie.zip
   extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkie-talkie-*' | head -n 1)

   rsync -a --delete \
     --exclude '.env' \
     --exclude 'node_modules' \
     --exclude '.git' \
     "$extracted_dir"/ "$CLAWKIE_SOURCE_DIR"/

   cd "$CLAWKIE_SOURCE_DIR"
   ```

5. Run dependency install again from the source directory:

   ```bash
   npm install
   ```

6. Reinstall/update the OpenClaw skill from the refreshed source, then patch the installed copy using the preserved `DAEMON_PEER_ID`. Never leave the installed skill with `<CONFIGURE_DAEMON_PEER_ID>` after an upgrade.
7. Restart only the Clawkie Talkie user service and run the same daemon, service, and skill verification checks listed below.
8. If verification fails, keep the preserved `.env` and report the failing command/output. Do not keep retrying with a new host ID.

## Prerequisites to verify

From the user's shell account that will run the daemon:

```bash
node -v
npm -v
command -v openclaw
openclaw --version || true
openclaw status
```

Use Node 22 LTS or newer when possible. OpenClaw must be 2026.4.25 or newer. If `openclaw` is missing, older than 2026.4.25, or not configured, stop the Clawkie Talkie install and help the user update/configure OpenClaw first. Do not continue until the same OS user that will run the daemon has a working OpenClaw 2026.4.25+ install.

## Install dependencies

From the repo root:

```bash
npm install
```

`@roamhq/wrtc` normally installs a prebuilt native package for supported macOS/Linux architectures. If it fails, install platform build tools and retry. See `docs/install-daemon.md` for platform-specific notes.

## Configure `.env`

For a fresh install, create the repo-root `.env` file from the example. For an upgrade/reinstall, preserve the existing `.env` and skip this copy step unless the file is missing and the user approved recreating it:

```bash
if [ ! -f .env ]; then
  cp .env.example .env
fi
chmod 600 .env
```

You — the installer — generate one stable daemon host UUID for this machine. The same UUID goes into the daemon's `.env` as `DAEMON_PEER_ID` and into the runtime-installed handoff skill as `CLAWKIE_DAEMON_HOST_ID`. This works the same way LobsterLink stores its discovered Chrome extension ID into the LobsterLink skill: a value generated/discovered at install time, written into the runtime skill, and used directly thereafter. The user does not need to know or configure this UUID.

Generate it once:

```bash
node -e "console.log(require('node:crypto').randomUUID())"
```

Set this value in `.env`:

```env
DAEMON_PEER_ID=<installer-generated-uuid>
```

The daemon does not require any provider API key in `.env`. All LLM/STT/TTS auth is read by `openclaw` itself from its own configuration and auth profiles when the daemon shells out to the CLI.

Do not regenerate the UUID on later updates, reinstalls, dependency repairs, or service repairs — keep it stable so existing handoff links and the installed skill remain valid.

A normal install only needs `DAEMON_PEER_ID` in `.env`. Do not add other variables unless the user explicitly asks for an override.

Advanced overrides (rare — leave unset for normal installs):

- `CT_STT_LANGUAGE` — optional language hint forwarded to `openclaw infer audio transcribe`. Default lets the transcription model auto-detect.
- `CT_THREAD_ID` — fallback Discord thread ID for transcript/debug posts when the daemon is invoked without a session that derives one. Not part of OpenClaw infer/provider setup.
- `CT_CLIENT_ORIGIN` — override the client origin printed in the Join URL. Installed daemons already default to `https://clawkietalkie.app`. Not part of OpenClaw infer/provider setup. The signaling server is non-configurable for end-user installs.

## Configure OpenClaw infer support

Clawkie Talkie uses the installed `openclaw` CLI for speech-to-text and text-to-speech:

- STT: `openclaw infer audio transcribe --file <wav> --json`
- TTS: `openclaw infer tts convert --text <text> --output <file> --json --local`

Before daemon verification, make sure the user's durable OpenClaw config (`openclaw.json`) has working providers for both infer surfaces. Do not rely only on shell environment variables unless they are also available to the persistent daemon service.

### If infer is not already working

Do **not** improvise around missing infer support by installing random local speech packages, building `whisper-cpp`, editing protected OpenClaw config files directly, or relying on a no-key TTS provider by itself. Clawkie Talkie needs **both**:

- a working audio transcription provider; and
- a working text-to-speech provider.

If `openclaw infer audio providers --json` or `openclaw infer tts providers --json --local` shows no usable provider, the normal repair path is to help the user configure a hosted provider through OpenClaw first.

Recommended choices:

1. **OpenAI** — best default for most users because it supports both STT and TTS in OpenClaw.
2. **xAI** — good alternative if the user has or prefers an xAI API key; it also supports both STT and TTS in OpenClaw.

Ask the user which provider they want, then have them enter the API key through OpenClaw's onboarding/auth flow. Do not ask them to paste API keys into chat, do not print keys in logs, and do not commit or write provider credentials into this repo.

#### OpenAI infer setup

Use this when the user chooses OpenAI or already has an OpenAI API key available locally:

```bash
openclaw onboard --auth-choice openai-api-key

openclaw config set messages.tts.provider openai
openclaw config set messages.tts.providers.openai \
  '{"model":"gpt-4o-mini-tts","voice":"coral"}' \
  --strict-json --merge
openclaw config set tools.media.audio.models \
  '[{"type":"provider","provider":"openai","model":"gpt-4o-transcribe"}]' \
  --strict-json
```

#### xAI infer setup

Use this when the user chooses xAI or already has an xAI API key available locally:

```bash
openclaw onboard --auth-choice xai-api-key

openclaw config set messages.tts.provider xai
openclaw config set messages.tts.providers.xai \
  '{"voiceId":"eve"}' \
  --strict-json --merge
openclaw config set tools.media.audio.models \
  '[{"type":"provider","provider":"xai","model":"grok-stt"}]' \
  --strict-json
```

After either setup path, rerun the provider inventory and smoke tests below. Do not continue to daemon/service/skill verification until both STT and TTS pass.

Microsoft or other no-key TTS providers may be used only if audio transcription is also working and the smoke tests pass. A working TTS provider alone is not a Clawkie Talkie install.

Inspect the current config and provider inventory:

```bash
openclaw config get tools.media.audio --json || true
openclaw config get messages.tts --json || true
openclaw infer audio providers --json
openclaw infer tts providers --json --local
```

Requirements:

- `openclaw infer audio providers --json` must show at least one transcription provider with `configured: true`, or `tools.media.audio.models` must point at a working CLI fallback.
- `openclaw infer tts providers --json --local` must show at least one usable speech provider.
- `openclaw infer tts voices --provider <provider> --json` should list voices or return a provider-specific success response.
- `openclaw infer tts convert ... --local --json` must create an output file.

If the user's OpenClaw install does not have infer audio/TTS configured or auto-detectable, Clawkie Talkie is not installed successfully yet. The daemon may still print a Join URL and accept a phone connection, but the first voice turn will fail at runtime:

- missing/broken audio transcription → `openclaw infer audio transcribe` fails, the phone receives `stt.error`, and the UI shows `INFER ERROR · OPENCLAW INFER STT FAILED`
- missing/broken TTS → `openclaw infer tts convert` fails after the agent reply, the phone receives `tts.error`, and the UI shows `TTS ERROR · OPENCLAW INFER TTS FAILED`

Installer responsibility in that state:

1. Do **not** report success and do **not** leave this as a runtime problem for the user.
2. Configure or repair the missing OpenClaw infer surface for the same OS user that will run the daemon.
3. Prefer an already-authenticated OpenClaw provider or already-installed local CLI. Preserve any existing working provider config and only add the missing audio/TTS pieces.
4. If multiple providers are available, choose the least invasive working option and state what was chosen in the final report.
5. If no usable provider credentials or local CLI are available, stop with a concrete blocker: which infer command failed, which config surface is missing (`tools.media.audio` or `messages.tts`), and what safe auth/config step the user must provide. Do not ask the user to paste secrets into a public/shared chat.
6. Rerun the smoke tests below after every config change. Only continue once both STT and TTS smoke tests pass.

Use the provider-specific OpenClaw docs for exact `tools.media.audio` and `messages.tts` fields. Use the OpenClaw config tooling rather than hand-editing when possible. For example, replace these placeholders with the provider/model the user already has configured credentials for:

```bash
openclaw config set tools.media.audio '{"enabled":true,"models":[{"type":"provider","provider":"<stt-provider>","model":"<stt-model>"}]}' --strict-json --merge
openclaw config set messages.tts '{"provider":"<tts-provider>","providers":{"<tts-provider>":{}}}' --strict-json --merge
```

If the user already has OpenAI, Deepgram, ElevenLabs, Microsoft, or another supported provider configured and the smoke tests pass, keep it. If a provider uses SecretRefs, verify they resolve for the daemon's user account before reporting success.

Run infer smoke tests:

```bash
TTS_PROVIDER=<configured-tts-provider>
rm -f /tmp/clawkie-openclaw-infer-smoke.mp3
openclaw infer tts voices --provider "$TTS_PROVIDER" --json || openclaw infer tts voices --json
openclaw infer tts convert \
  --text "clawkie infer smoke test" \
  --output /tmp/clawkie-openclaw-infer-smoke.mp3 \
  --json \
  --local
test -s /tmp/clawkie-openclaw-infer-smoke.mp3
openclaw infer audio transcribe --file /tmp/clawkie-openclaw-infer-smoke.mp3 --json
```

If the TTS smoke passes but audio transcription fails, fix `tools.media.audio` before continuing. If audio transcription passes but TTS fails, fix `messages.tts` before continuing.

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

- Install mode: fresh install, upgrade, or reinstall/repair
- Daemon source path
- Whether dependencies installed
- Whether `.env` exists and contains `DAEMON_PEER_ID`
- Whether `DAEMON_PEER_ID` is stable/configured, without printing it unless the user explicitly asks
- OpenClaw infer config present for `audio transcribe` and `tts convert`
- `openclaw infer audio providers`, `tts providers`, `tts voices`, and smoke-test results
- Persistence method installed: launchd or systemd user service
- Service status/log evidence
- Skill destination path
- Skill configured: yes/no
- Verification commands run
- Any blockers

Avoid posting the daemon host ID into public/shared chat unless necessary.
