# Clawkie Talkie Agent Install — Verification

Run these checks before reporting success for a fresh install, upgrade, repair, or reinstall.

## Prerequisite verification

Run from the user's shell account that will run the daemon:

```bash
node -v
npm -v
command -v ffmpeg
ffmpeg -version
command -v openclaw
openclaw --version || true
openclaw status --json
```

OpenClaw must be 2026.4.25 or newer. If `openclaw` is missing, older, or not configured, stop Clawkie Talkie work and mark OpenClaw/auth/gateway as the blocker; only continue with Clawkie-side workarounds or docs after that boundary is explicit. If `ffmpeg` is missing, install it before daemon verification; OpenClaw TTS can successfully generate an MP3 while the daemon still fails because it cannot decode that MP3 to PCM for WebRTC.

## Infer verification

Run the provider inspection and smoke tests from [`agent-install-infer.md`](agent-install-infer.md). Do not continue until both STT and TTS pass.

From the Clawkie Talkie source directory, the Node preflight can run the status + infer smoke checks together:

```bash
npm run agent-install-preflight
```

This checks Node/npm, `openclaw --version`, `openclaw status --json`, `command -v ffmpeg`, `openclaw infer audio transcribe`, `openclaw infer tts convert`, and an `ffmpeg` MP3-to-PCM decode of the TTS output. Passing status/infer/audio-decode checks still does not prove the daemon can run an agent reply.

## Manual daemon verification

Run once from the repo root:

```bash
npm run daemon
```

Success looks like:

```text
Peer ID:  <DAEMON_PEER_ID>
Join URL: https://clawkietalkie.app/dashboard/#host=<DAEMON_PEER_ID>
Waiting for phone…
```

Verify the printed `Peer ID` matches `.env` exactly. Stop the manual run with `Ctrl-C` before installing the persistent service.

## Persistence verification

After persistence is installed:

- macOS: `launchctl print gui/$(id -u)/app.clawkietalkie.daemon`
- Linux: `systemctl --user status clawkie-talkie.service`
- Logs include `Peer ID: <DAEMON_PEER_ID>` or `subscribed to rendezvous room as <DAEMON_PEER_ID>`.
- The service restarts cleanly after a manual restart command.

## Skill install verification

A robust check should parse the configured host line instead of grepping the entire file for placeholder words:

```bash
configured_host=$(awk -F'= ' '/^- CLAWKIE_DAEMON_HOST_ID = / {gsub(/`/, "", $2); print $2; exit}' "$CLAWKIE_SKILL_DIR/SKILL.md")
test "$configured_host" = "$DAEMON_PEER_ID"
```

Confirm:

1. The installed skill exists at the runtime path.
2. The installed skill says `INSTALLED = true`.
3. The skill's configuration bullet for `CLAWKIE_DAEMON_HOST_ID` was patched from the repo placeholder to the daemon `.env` `DAEMON_PEER_ID`.
4. No active config line remains exactly `CLAWKIE_DAEMON_HOST_ID = <CONFIGURE_DAEMON_PEER_ID>`.
5. The installed skill's `CLAWKIE_DAEMON_HOST_ID` matches the daemon `.env` `DAEMON_PEER_ID`.

Construct a dry-run handoff URL using the same algorithm as the skill:

```js
const params = new URLSearchParams();
params.set('host', daemonPeerId);
params.set('session', '<actual-openclaw-session-id-uuid>');
params.set('sessionKey', 'agent:main:discord:channel:EXAMPLE');
params.set('channel', 'discord');
params.set('target', 'channel:EXAMPLE');
console.log(`https://clawkietalkie.app/voice#${params.toString()}`);
```

The dry-run URL must include `host` and `session`. Prefer the actual OpenClaw sessionId UUID for `session`; use a session key only as fallback when the UUID is not visible. When visible, include `sessionKey`, `channel`, `target`, and optional `accountId` so the daemon can select the right agent, deliver assistant replies explicitly, and mirror transcripts best-effort. For internal/webchat sessions, `session=agent:main:main` is valid only as fallback. The skill must never emit `agent:main:main` for external channels such as Discord, Slack, or WhatsApp.

## Real handoff-link smoke test

Run a real handoff-link smoke test in the current OpenClaw runtime by asking for `switch to voice` from the surface being installed for.

Inspect the generated URL before trying the phone:

- It must use `/voice#` hash args.
- It must include the configured daemon `host`.
- For web chat, `session=agent%3Amain%3Amain` is valid only when no actual sessionId UUID is visible.
- For Discord/Slack/etc., prefer the actual sessionId UUID in `session`; if the UUID is not visible, use the correct external session key, not `session=agent%3Amain%3Amain`.
- If trusted runtime context exposes `sessionKey`, `channel`, `target`, or `accountId`, the URL should preserve them for agent selection, explicit reply delivery, and best-effort transcript mirroring.

## Pre-emptive OpenClaw agent-turn check

`openclaw status --json`, STT, TTS, and daemon rendezvous registration are not enough. The install is not voice-ready until the daemon can run an OpenClaw chat turn without `openclaw_gateway_unavailable`.

Use the real stored OpenClaw session id/UUID for the current conversation. Handoff URLs and skills use session **keys** such as `agent:main:main` or `agent:main:discord:channel:<id>`, but current `openclaw agent --session-id` expects the stored id/UUID from the OpenClaw state dir (`OPENCLAW_STATE_DIR`, else `dirname(OPENCLAW_CONFIG_PATH)`, else `<OPENCLAW_HOME-or-home>/.openclaw`). Resolve the key first when testing the CLI directly.

```bash
SESSION_KEY="agent:main:discord:channel:<id>" # or agent:main:main for web chat
OPENCLAW_STORED_SESSION_ID=$(SESSION_KEY="$SESSION_KEY" python - <<'PY'
import json, os
from pathlib import Path

def clean(value):
    value = (value or '').strip()
    return value if value and value not in ('undefined', 'null') else None

def resolve_user_path(value, home):
    value = value.strip()
    if value == '~' or value.startswith('~/'):
        value = str(home) + value[1:]
    return Path(value).resolve()

key = os.environ['SESSION_KEY']
agent = key.split(':', 2)[1]
home = resolve_user_path(clean(os.environ.get('OPENCLAW_HOME')) or str(Path.home()), Path.home())
if clean(os.environ.get('OPENCLAW_STATE_DIR')):
    state_dir = resolve_user_path(os.environ['OPENCLAW_STATE_DIR'], home)
elif clean(os.environ.get('OPENCLAW_CONFIG_PATH')):
    state_dir = resolve_user_path(os.environ['OPENCLAW_CONFIG_PATH'], home).parent
else:
    state_dir = home / '.openclaw'
path = state_dir / 'agents' / agent / 'sessions' / 'sessions.json'
print(json.load(open(path))[key]['sessionId'])
PY
)
openclaw agent \
  --agent main \
  --session-id "$OPENCLAW_STORED_SESSION_ID" \
  --json \
  --timeout 60 \
  -m "Clawkie Talkie install smoke test. Reply with exactly: ok"
```

Or run the equivalent repo preflight gate:

```bash
npm run agent-install-preflight -- --require-agent-turn --session-id "$OPENCLAW_STORED_SESSION_ID"
```

By default this verifies the agent-turn path without passing `--deliver`, so it should not post a smoke-test reply. To intentionally prove delivery into the current conversation, add explicit reply routing to the direct command or to the repo preflight:

```bash
openclaw agent --agent main --session-id "$OPENCLAW_STORED_SESSION_ID" --deliver --reply-channel discord --reply-to "channel:<id>" --json --timeout 60 -m "Clawkie Talkie install smoke test. Reply with exactly: ok"
npm run agent-install-preflight -- --require-agent-turn --session-id "$OPENCLAW_STORED_SESSION_ID" --deliver --reply-channel discord --reply-to "channel:<id>"
```

If there is no real session key/stored session id available, do not fake one. Mark this verification as blocked until a real `switch to voice` handoff can be generated from a live OpenClaw session.

If this check fails with `scope upgrade pending approval`, `pending device approval`, or a pending `openclaw devices approve <requestId>` command, treat it as an early actionable failure even if `openclaw status --json`, STT, and TTS all passed. The agent reply path needs upgraded local gateway scopes: `operator.pairing`, `operator.read`, and `operator.write`. Record the request ID, tell the user to approve the pending device/scope request in the OpenClaw dashboard or run the shown approval command, and report the install as **blocked pending device approval**. After approval, rerun the agent-turn preflight/check and restart the daemon service if needed.

If you get connection errors, auth errors, gateway errors, or session lookup errors, stop and mark OpenClaw/auth/gateway/session lookup as the blocker. Do not imply this branch repairs OpenClaw itself; only apply Clawkie-side workarounds when the failure is inside Clawkie.

## Persistent daemon agent-turn check

Do not rely only on `openclaw status --json`, STT, TTS, or a daemon `Waiting for phone…` log line. Verify one of these before reporting success:

- Preferred: complete a real phone voice smoke test. Logs must show STT, `[chat] running OpenClaw turn`, a successful agent reply, TTS conversion, and no fatal `openclaw_gateway_unavailable`.
- If no phone is available: resolve the handoff session key to its stored session id/UUID, then run the same `openclaw agent --agent <agent-from-session-key> --session-id <stored-session-id-or-uuid> --json --timeout 60 -m <smoke-message>` command from the same OS user and environment shape that the service uses. Add `--deliver --reply-channel <channel> --reply-to <target>` only when intentionally testing explicit reply delivery. For systemd installs, inspect the user service environment and fix missing `OPENCLAW_*`, auth, `PATH`, or gateway settings before claiming success.

## Required final report

Report only non-secret facts:

- Install mode: fresh install, upgrade, or reinstall/repair
- Daemon source path
- Whether dependencies installed
- Whether `.env` exists and contains `DAEMON_PEER_ID`
- Whether `DAEMON_PEER_ID` is stable/configured, without printing it unless the user explicitly asks
- OpenClaw infer config present for `audio transcribe` and `tts convert`
- `ffmpeg` installed and available to the daemon service user
- `openclaw infer audio providers`, `tts providers`, `tts voices`, and smoke-test results
- Persistence method installed: launchd or systemd user service
- Service status/log evidence, including proof the persistent daemon service can run an OpenClaw agent turn without `openclaw_gateway_unavailable`
- Skill destination path
- Skill configured: yes/no
- Verification commands run
- Confirmation that agent/default model config was snapshotted before infer config and unchanged afterward
- Any blockers

Avoid posting the daemon host ID into public/shared chat unless necessary.
