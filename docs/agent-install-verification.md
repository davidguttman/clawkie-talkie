# Clawkie Talkie Agent Install — Verification

Run these checks before reporting success for a fresh install, upgrade, repair, or reinstall.

## Prerequisite verification

Run from the user's shell account that will run the daemon:

```bash
node -v
npm -v
command -v openclaw
openclaw --version || true
openclaw status
```

OpenClaw must be 2026.4.25 or newer. If `openclaw` is missing, older, or not configured, stop Clawkie Talkie work and repair OpenClaw first.

## Infer verification

Run the provider inspection and smoke tests from [`agent-install-infer.md`](agent-install-infer.md). Do not continue until both STT and TTS pass.

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
params.set('session', 'agent:main:discord:channel:EXAMPLE');
console.log(`https://clawkietalkie.app/voice#${params.toString()}`);
```

The dry-run URL must include only `host` and `session` in the hash. It must not include URL `channel` or `target`. For internal/webchat sessions, `session=agent:main:main` is valid. The skill must never emit `agent:main:main` for external channels such as Discord, Slack, or WhatsApp; external channels require the exact external session key.

## Real handoff-link smoke test

Run a real handoff-link smoke test in the current OpenClaw runtime by asking for `switch to voice` from the surface being installed for.

Inspect the generated URL before trying the phone:

- It must use `/voice#` hash args.
- It must include the configured daemon `host`.
- For web chat, `session=agent%3Amain%3Amain` is valid.
- For Discord/Slack/etc., it must include the correct external `session`, not `session=agent%3Amain%3Amain`.
- It must not include URL `channel` or `target`.

## Pre-emptive OpenClaw agent-turn check

`openclaw status`, STT, TTS, and daemon rendezvous registration are not enough. The install is not voice-ready until the daemon can run an OpenClaw chat turn without `openclaw_gateway_unavailable`.

Use the real session key for the current conversation. For OpenClaw web chat, that is normally `agent:main:main`. For external channels, do not use `agent:main:main`; use the exact external session key such as `agent:main:discord:channel:<id>`.

```bash
SESSION_ID="<exact-current-session-id-or-key>"
openclaw agent \
  --agent main \
  --session-id "$SESSION_ID" \
  --channel last \
  --deliver \
  --json \
  -m "Clawkie Talkie install smoke test. Reply with exactly: ok"
```

This may deliver a small smoke-test reply to the current conversation. That is preferable to reporting a broken voice install as complete.

If there is no real session key available, do not fake one. Mark this verification as blocked until a real `switch to voice` handoff can be generated from a live OpenClaw session.

If you see scope approval prompts in logs, record the request ID, tell the user to approve the pending device/scope request in the OpenClaw dashboard, and report the install as **blocked pending device approval**. After approval, rerun this check and restart the daemon service if needed.

If you get connection errors, auth errors, gateway errors, or session lookup errors, fix those before proceeding.

## Persistent daemon agent-turn check

Do not rely only on `openclaw status`, STT, TTS, or a daemon `Waiting for phone…` log line. Verify one of these before reporting success:

- Preferred: complete a real phone voice smoke test. Logs must show STT, `[chat] running OpenClaw turn`, a successful agent reply, TTS conversion, and no fatal `openclaw_gateway_unavailable`.
- If no phone is available: run the same `openclaw agent --agent main --session-id <exact-session> --channel last --deliver --json -m <smoke-message>` command from the same OS user and environment shape that the service uses. For systemd installs, inspect the user service environment and fix missing `OPENCLAW_*`, auth, `PATH`, or gateway settings before claiming success.

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
- Service status/log evidence, including proof the persistent daemon service can run an OpenClaw agent turn without `openclaw_gateway_unavailable`
- Skill destination path
- Skill configured: yes/no
- Verification commands run
- Confirmation that agent/default model config was snapshotted before infer config and unchanged afterward
- Any blockers

Avoid posting the daemon host ID into public/shared chat unless necessary.
