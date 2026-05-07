# Clawkie Talkie — Agent Install Instructions

These instructions are for an agent installing, reinstalling, or upgrading Clawkie Talkie on a user's Mac or Linux machine.

Keep this file as the control-plane install path. Use linked docs for repair, provider setup, deep verification, and troubleshooting.

## Success criteria

Before reporting success, verify all of this:

1. Clawkie Talkie source is installed or upgraded from `davidguttman/clawkie-talkie`.
2. The daemon has a stable `DAEMON_PEER_ID` in repo-root `.env`.
3. The daemon is persistent after login/reboot through launchd or `systemd --user`.
4. The OpenClaw `clawkie-voice-handoff` skill is installed and points at the same daemon host ID.
5. OpenClaw infer STT and TTS work for the same OS user that runs the daemon.
6. `ffmpeg` is installed and available on `PATH` for the daemon service user, because the daemon currently decodes OpenClaw TTS output into PCM before sending it over WebRTC.
7. The daemon, skill, infer config, persistence, and OpenClaw agent-turn path are verified. See [`docs/agent-install-verification.md`](docs/agent-install-verification.md).

## Nontechnical user contract

Assume the user is nontechnical. Do every safe, automatable step yourself: inspect paths, download source, install dependencies, edit supported config through CLIs, install persistence, install the skill, and run verification.

Ask the user only for irreducible human input, such as provider choice, an API key entered locally into a hidden prompt or OpenClaw auth UI, OS/security approval, browser login, physical-device permission, or confirmation before replacing a broken install when preserving local config is impossible.

Never ask the user to paste provider API keys into chat. Never print keys in logs or summaries. The daemon does not hold provider API keys; STT/TTS/LLM auth lives in OpenClaw config.

## Hard boundaries

- OpenClaw **2026.4.25 or newer** must work for the same OS user that will run the daemon before Clawkie Talkie install begins.
- Do not treat an OpenClaw update/repair as optional. Stop Clawkie Talkie work until `openclaw status --json` works on 2026.4.25+.
- Do not commit `.env`, generated host IDs, LaunchAgent plists with private paths, or systemd unit files with private paths.
- Do not paste or print provider API keys.
- Treat `DAEMON_PEER_ID` and the dashboard URL as bearer routing material. Anyone with it can open the host dashboard, enumerate/select recent sessions exposed by the daemon, and attempt voice handoff. Do not publish it or post it in public/shared chats; rotate `DAEMON_PEER_ID` and update the installed skill/config if exposed.
- Use the public client origin: `https://clawkietalkie.app`.
- Do not use local development shortcuts for an end-user install.
- Do not start/stop unrelated OpenClaw, browser, Docker, or system services.
- Do not change the user's default/chat agent LLM while configuring infer. See [`docs/agent-install-infer.md`](docs/agent-install-infer.md).

## Source

Public GitHub repo: `davidguttman/clawkie-talkie`

## Required variables

Discover these from the active runtime and user's machine; do not copy maintainer-specific paths.

```bash
OPENCLAW_WORKSPACE="/absolute/path/to/this-openclaw-workspace"
CLAWKIE_SOURCE_DIR="$OPENCLAW_WORKSPACE/external/clawkie-talkie"
OPENCLAW_SKILLS_DIR="${OPENCLAW_SKILLS_DIR:-$OPENCLAW_WORKSPACE/skills}"
CLAWKIE_SKILL_DIR="$OPENCLAW_SKILLS_DIR/clawkie-voice-handoff"
```

If the active OpenClaw workspace or skills directory cannot be determined, stop and ask the user.

## Choose install mode first

- **Fresh install:** no existing source directory, daemon `.env`, persistence service, or installed handoff skill exists.
- **Upgrade:** Clawkie Talkie already exists and should keep the same `.env`, `DAEMON_PEER_ID`, persistence method, and installed skill configuration.
- **Reinstall/repair:** source files or dependencies are broken. Preserve secrets and IDs first, then replace code.

For upgrade or reinstall/repair, do not continue here. Use [`docs/agent-install-upgrade-repair.md`](docs/agent-install-upgrade-repair.md).

## Fresh install flow

### 1. Verify prerequisites

Run as the OS user that will run the daemon:

```bash
node -v
npm -v
command -v ffmpeg
command -v openclaw
openclaw --version || true
openclaw status --json
```

Use Node 22 LTS or newer when possible. Install `ffmpeg` before daemon verification if it is missing. Stop until OpenClaw 2026.4.25+ is installed and configured. After the source is present, use the repo preflight script for repeatable status/infer/agent-turn checks.

### 2. Fetch and inspect source

Refuse to overwrite an existing target in fresh-install mode:

```bash
if [ -e "$CLAWKIE_SOURCE_DIR" ]; then
  echo "$CLAWKIE_SOURCE_DIR already exists; use upgrade/repair" >&2
  exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"
curl -L -o clawkie-talkie.zip https://github.com/davidguttman/clawkie-talkie/archive/HEAD.zip
unzip -q clawkie-talkie.zip
extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkie-talkie-*' | head -n 1)
mkdir -p "$(dirname "$CLAWKIE_SOURCE_DIR")"
mv "$extracted_dir" "$CLAWKIE_SOURCE_DIR"
cd "$CLAWKIE_SOURCE_DIR"
```

Expected items:

- Node/npm project files
- TypeScript daemon under `daemon/src/`
- browser client under `client/`
- OpenClaw skill under `openclaw/clawkie-voice-handoff/SKILL.md`
- docs under `docs/`

Stop on unexpected credential collection, remote shell execution, install-time global mutation without consent, or code that exfiltrates `.env`, OpenClaw config, browser cookies, or arbitrary files.

### 3. Install dependencies

```bash
npm install
```

If `@roamhq/wrtc` fails, install platform build tools and retry. See [`docs/install-daemon.md`](docs/install-daemon.md).

### 4. Configure `.env`

```bash
cp .env.example .env
chmod 600 .env
DAEMON_PEER_ID=$(node -e "console.log(require('node:crypto').randomUUID())")
printf 'DAEMON_PEER_ID=%s\n' "$DAEMON_PEER_ID" > .env
```

The same UUID must be written into the installed handoff skill as `CLAWKIE_DAEMON_HOST_ID`. Do not regenerate it on later updates, dependency repairs, or service repairs.

A normal install only needs `DAEMON_PEER_ID`. Leave advanced overrides unset unless the user explicitly asks: `CT_STT_LANGUAGE`, `CT_THREAD_ID`, `CT_CLIENT_ORIGIN`.

### 5. Configure and verify OpenClaw infer

Clawkie Talkie needs both:

- STT: `openclaw infer audio transcribe --file <wav> --json`
- TTS: `openclaw infer tts convert --text <text> --output <file> --json`

Use [`docs/agent-install-infer.md`](docs/agent-install-infer.md). Do not continue until infer smoke tests pass.

### 6. Install persistence

Use [`docs/install-daemon.md`](docs/install-daemon.md) for launchd/systemd examples.

After installing persistence, verify with [`docs/agent-install-verification.md`](docs/agent-install-verification.md): service status, logs, matching peer ID, clean restart, and daemon agent-turn path.

### 7. Install the OpenClaw skill

```bash
mkdir -p "$CLAWKIE_SKILL_DIR"
cp openclaw/clawkie-voice-handoff/SKILL.md "$CLAWKIE_SKILL_DIR/SKILL.md"
```

Patch the installed copy only:

- `INSTALLED = false` → `INSTALLED = true`
- `Install date:` → today's date in `YYYY-MM-DD` format
- `CLAWKIE_DAEMON_HOST_ID = <CONFIGURE_DAEMON_PEER_ID>` → the exact `DAEMON_PEER_ID` from `.env`

Do not patch the source copy with the real host ID. The daemon `.env` `DAEMON_PEER_ID` must equal the installed skill's `CLAWKIE_DAEMON_HOST_ID`.

## Required verification gate

Before reporting success, run every applicable check in [`docs/agent-install-verification.md`](docs/agent-install-verification.md), including:

- manual daemon check
- persistent service check
- OpenClaw infer smoke tests
- installed skill config check
- real handoff-link smoke test
- OpenClaw agent-turn smoke test using the real stored OpenClaw session id/UUID
- final report checklist

Use the Node preflight as the repeatable gate when a real stored OpenClaw session id is available:

```bash
npm run agent-install-preflight -- --require-agent-turn --session-id "$OPENCLAW_STORED_SESSION_ID"
```

Handoff URLs carry a session **key** such as `agent:main:main` or `agent:main:discord:...`. Current `openclaw agent --session-id` expects the stored session id/UUID from the OpenClaw state dir (`OPENCLAW_STATE_DIR`, else `dirname(OPENCLAW_CONFIG_PATH)`, else `<OPENCLAW_HOME-or-home>/.openclaw`). The daemon resolves URL session keys before invoking the CLI; direct preflight commands should use the stored id/UUID, not a colon-containing session key.

By default the preflight agent-turn smoke test does **not** deliver a reply. If you intentionally need to prove explicit reply delivery into the originating channel/thread too, opt in with a reply target:

```bash
npm run agent-install-preflight -- --require-agent-turn --session-id "$OPENCLAW_STORED_SESSION_ID" --deliver --reply-channel discord --reply-to "channel:<id>"
```

`openclaw status --json`, infer STT, and infer TTS can all pass while the daemon still cannot run agent replies because the local gateway is waiting on a scope/device approval. The `--session-id` agent-turn preflight is the relevant gate for that class of issue.

If verification fails, use [`docs/agent-install-troubleshooting.md`](docs/agent-install-troubleshooting.md). Do not report success with unresolved infer, service, handoff URL, device approval, auth, gateway, or session-key failures.
