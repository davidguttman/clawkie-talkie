# Clawkie Talkie Agent Install — Troubleshooting

Use this after the normal install or verification path fails. Do not report success while any issue here remains unresolved.

## Common runtime symptoms

Infer failures usually surface like this:

- missing/broken audio transcription → `openclaw infer audio transcribe` fails, the phone receives `stt.error`, and the UI shows `INFER ERROR · OPENCLAW INFER STT FAILED`
- missing/broken TTS → `openclaw infer tts convert` fails after the agent reply, the phone receives `tts.error`, and the UI shows `TTS ERROR · OPENCLAW INFER TTS FAILED`
- missing `ffmpeg` after successful TTS generation → `openclaw infer tts convert` can create an MP3, but the daemon cannot decode that MP3 to PCM for WebRTC, so the phone still receives `tts.error` / `TTS ERROR · OPENCLAW INFER TTS FAILED`

For infer failures, return to [`agent-install-infer.md`](agent-install-infer.md). If OpenClaw TTS succeeds but daemon voice replies fail at the TTS audio step, verify `ffmpeg` first. If status/infer checks pass but voice replies fail before or during the OpenClaw chat turn, move directly to the agent-turn check/preflight; status and infer are not the relevant gate for reply-scope approval failures.

After the user first tries `switch to voice`, they may see:

```text
VOICE ERROR · openclaw_gateway_unavailable
```

Check daemon logs. Common causes:

1. **Service-context gateway/auth failure** — the daemon's systemd/launchd environment cannot reach or authenticate to the OpenClaw gateway even though the installer's interactive shell can.
2. **Scope upgrade pending approval** — the daemon's `openclaw agent --json` path (and especially explicit `--deliver` checks) can be treated as a new device connection requesting more permissions than currently approved.
3. **Invalid session ID for the surface** — prefer the actual OpenClaw sessionId UUID. `agent:main:main` is valid only as a web-chat fallback, and is wrong for Discord/Slack/etc.; external channels need the UUID or their exact external session key.

## Fix scope approval / device auth

If daemon logs or `npm run agent-install-preflight -- --require-agent-turn --session-id "$SESSION_ID"` show `scope upgrade pending approval`, `pending device approval`, or a pending `openclaw devices approve <requestId>` command:

1. Tell the user to open their OpenClaw dashboard. The URL is typically the gateway address with port 18789, for example:

   ```text
   http://<gateway-ip>:18789/
   ```

2. In the dashboard, look for a pending pairing/scope approval request.
3. The request ID will appear in daemon logs, e.g. `requestId a8b414c2-0d4b-4266-85b8-ab94662dce18`.
4. Ask the user to approve the request so the daemon can connect to the gateway for agent turns. The needed upgraded local gateway scopes are `operator.pairing`, `operator.read`, and `operator.write`. If the CLI printed `openclaw devices approve <requestId>`, that is the concrete approval command.
5. After approval, restart only the daemon service:

   - macOS: `launchctl kickstart -k gui/$(id -u)/app.clawkietalkie.daemon`
   - Linux: `systemctl --user restart clawkie-talkie.service`

Then rerun the agent-turn check/preflight in [`agent-install-verification.md`](agent-install-verification.md). Do not mark the install successful just because `openclaw status --json`, STT, or TTS passes.

## Verify session ID in handoff URLs

The handoff URL must include a real session ID/key in the `session` parameter.

Valid actual sessionId example:

```text
https://clawkietalkie.app/voice#host=<peer-id>&session=c44d9502-ce71-46b1-9b15-5d548004544a
```

If the URL contains `session=agent%3Amain%3Amain` for Discord/Slack/etc., `session=agent%3Amain%3Awebchat`, or any URL `channel`/`target` parameter, the `clawkie-voice-handoff` skill is not resolving the current conversation correctly. A colon-style external session key is acceptable only when the actual OpenClaw sessionId UUID is not visible.

Verify:

1. The skill is installed and `INSTALLED = true`.
2. The skill's `CLAWKIE_DAEMON_HOST_ID` matches the daemon's `DAEMON_PEER_ID`.
3. The current session has a valid actual sessionId UUID or fallback session key that the skill can read.

## Verify daemon service can run the agent turn

Before reporting success, verify one of these:

- Preferred: complete a real phone voice smoke test. Logs must show STT, `[chat] running OpenClaw turn`, successful agent reply, TTS conversion, and no fatal `openclaw_gateway_unavailable`.
- If no phone is available: run the same `openclaw agent --agent main --session-id <exact-session> --channel last --json --timeout 60 -m <smoke-message>` command from the same OS user and environment shape that the service uses. Add `--deliver` only when intentionally testing delivery.

For systemd installs, do not assume the interactive shell environment is equivalent. Inspect the user service environment and fix missing `OPENCLAW_*`, auth, `PATH`, or gateway settings before claiming success.

After device approval, handoff URL validation, and service-context agent-turn verification, `switch to voice` should work without `openclaw_gateway_unavailable`.
