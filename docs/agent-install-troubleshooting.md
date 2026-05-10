# Clawkie Talkie Agent Install — Troubleshooting

Use this after the normal install or verification path fails. Do not report success while any issue here remains unresolved.

## Common runtime symptoms

Infer failures usually surface like this:

- missing/broken audio transcription → `openclaw infer audio transcribe` fails, the phone receives `stt.error`, and the UI shows `INFER ERROR · OPENCLAW INFER STT FAILED`
- missing/broken TTS → `openclaw infer tts convert` fails after the agent reply, the phone receives `tts.error`, and the UI shows `TTS ERROR · OPENCLAW INFER TTS FAILED`
- missing `ffmpeg` after successful TTS generation → `openclaw infer tts convert` can create an MP3, but the daemon cannot decode that MP3 to PCM for WebRTC, so the phone still receives `tts.error` / `TTS ERROR · OPENCLAW INFER TTS FAILED`

For infer failures, return to [`agent-install-infer.md`](agent-install-infer.md). If OpenClaw TTS succeeds but daemon voice replies fail at the TTS audio step, verify `ffmpeg` first. If status/infer checks pass but voice replies fail before or during the OpenClaw chat turn, move directly to the agent-turn check/preflight; status and infer are not the relevant gate for reply-scope approval failures.

If the browser reports `Daemon protocol/capability mismatch. Update the installed daemon.`, the browser client is current by definition and the local service is the side that needs attention. Update the installed daemon from the current source, preserve `DAEMON_PEER_ID`, restart only the Clawkie Talkie service, and rerun verification.

After the user first tries `switch to voice`, they may see:

```text
VOICE ERROR · openclaw_gateway_unavailable
```

Check daemon logs. Common causes:

1. **Service-context gateway/auth failure** — the daemon's systemd/launchd environment cannot reach or authenticate to the OpenClaw gateway even though the installer's interactive shell can.
2. **Scope upgrade pending approval** — the daemon's `openclaw agent --json` path (and especially explicit `--deliver` checks) can be treated as a new device connection requesting more permissions than currently approved.
3. **Invalid session key/id for the surface** — `agent:main:main` is valid in a handoff URL for OpenClaw web chat, but wrong for Discord/Slack/etc.; external handoff URLs need their exact external session key. Manual `openclaw agent --session-id` checks need the stored session id/UUID resolved from that key.

## Fix scope approval / device auth

If daemon logs or `npm run agent-install-preflight -- --require-agent-turn --session-id "$OPENCLAW_STORED_SESSION_ID"` show `scope upgrade pending approval`, `pending device approval`, or a pending `openclaw devices approve <requestId>` command:

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

The handoff URL must include a real session key in the `session` parameter. This URL value may contain colons, for example `agent:main:discord:...`; the daemon resolves it to the stored OpenClaw session id/UUID before it calls `openclaw agent --session-id`. Do not pass a colon-containing URL session key directly to `openclaw agent --session-id` during manual CLI testing.

Valid external-channel example:

```text
https://clawkietalkie.app/voice#host=<peer-id>&session=agent%3Amain%3Adiscord%3Achannel%3A1498020851298209852
```

If the URL contains `session=agent%3Amain%3Amain` for Discord/Slack/etc., `session=agent%3Amain%3Awebchat`, or malformed URL `channel`/`target` metadata, stop and mark the handoff/OpenClaw runtime context as the blocker unless there is a clear Clawkie-side skill configuration workaround.

Verify:

1. The skill is installed and `INSTALLED = true`.
2. The skill's `CLAWKIE_DAEMON_HOST_ID` matches the daemon's `DAEMON_PEER_ID`.
3. The current session has a valid session key that the skill can read.

## Verify daemon service can run the agent turn

Before reporting success, verify one of these:

- Preferred: complete a real phone voice smoke test. Logs must show STT, `[chat] running OpenClaw turn`, successful agent reply, TTS conversion, and no fatal `openclaw_gateway_unavailable`.
- If no phone is available: resolve the handoff session key through the OpenClaw state dir (`OPENCLAW_STATE_DIR`, else `dirname(OPENCLAW_CONFIG_PATH)`, else `<OPENCLAW_HOME-or-home>/.openclaw`), then run `openclaw agent --agent <agent-from-session-key> --session-id <stored-session-id-or-uuid> --json --timeout 60 -m <smoke-message>` from the same OS user and environment shape that the service uses. Add `--deliver --reply-channel <channel> --reply-to <target>` only when intentionally testing explicit reply delivery into the originating channel/thread.

For systemd installs, do not assume the interactive shell environment is equivalent. Inspect the user service environment and either apply a Clawkie-side service environment workaround or mark missing `OPENCLAW_*`, auth, `PATH`, or gateway settings as the blocker before claiming success.

After device approval, handoff URL validation, and service-context agent-turn verification, `switch to voice` should work without `openclaw_gateway_unavailable`.
