---
name: clawkie-voice-handoff
description: Use when a user asks to switch to voice, move/continue this conversation by voice, start Clawkie/Clawkie-Talkie voice, create a Clawkie voice handoff/link, or says phrases like "do clawkie voice handoff". Build a Clawkie Talkie voice handoff URL from the current OpenClaw session context.
---

# Clawkie Voice Handoff

When the user asks to switch the current OpenClaw session to voice, reply with a Clawkie Talkie URL for this exact conversation.

## Install State

The installer patches the runtime-installed copy of this skill (not the repo source) with the values it generated when it configured the local daemon:

- INSTALLED = false
- Install date:
- CLAWKIE_DAEMON_HOST_ID = `<CONFIGURE_DAEMON_PEER_ID>`

`CLAWKIE_DAEMON_HOST_ID` is the stable daemon host UUID the installer generated and wrote to the daemon's `.env` as `DAEMON_PEER_ID`. The runtime-installed skill stores the same UUID and uses it directly when building a handoff URL. The repo-source copy keeps a non-secret sentinel in the configuration bullet above so it cannot leak a real machine ID.

If `INSTALLED` is not `true`, or `CLAWKIE_DAEMON_HOST_ID` is empty / not replaced with a real host ID, do not generate a link. Reply:

```txt
I can’t create the voice link: Clawkie Talkie is not installed/configured for this OpenClaw runtime.
```

## Hard rules

- Do **not** call a Clawkie helper just to create the URL.
- Do **not** call the Clawkie daemon to create or mutate handoff state.
- Do **not** create or reference handoff IDs, opaque tokens, registries, TTLs, claims, revocations, or lookup tables.
- Do **not** guess the current session id/key.
- Do **not** guess routing fields. Include `channel`, `target`, and `accountId` only when they are visible in trusted runtime/session context.
- Use the configured `CLAWKIE_DAEMON_HOST_ID` exactly as installed.
- If a required field is unavailable, say exactly which field is missing.

## URL contract

Generate only this public handoff URL shape:

```txt
https://clawkietalkie.app/voice#host=<host>&session=<sessionId>&sessionKey=<sessionKey>&channel=<channel>&target=<target>&accountId=<accountId>
```

`sessionKey`, `channel`, `target`, and `accountId` are optional only when those values are not visible. Include them whenever they are visible in trusted runtime/session context. `session` remains the session identity passed to `openclaw agent --session-id`; `sessionKey` selects the OpenClaw agent and can derive Discord reply/transcript routing; `channel` + `target` are the explicit originating reply route and are also used for best-effort transcript mirroring. If only a session key is visible, put that key in `session` and omit `sessionKey`. For OpenClaw web chat, `session=agent:main:main` is valid only as that fallback. If `target` is included, include `channel` too.

Use hash args so `sessionId`, session keys, and UUID-like values are not sent to web servers. Query params are compatibility-only; do not generate them unless explicitly requested.

`/voice` is the public handoff entrypoint. The browser joins the configured daemon rendezvous room first. The daemon derives the per-session voice room deterministically from `host + session` and runs the OpenClaw agent turn with explicit reply delivery: `--deliver --reply-channel <channel> --reply-to <target>`. The selected agent comes from `sessionKey`, a colon-style session key in `session`, or a UUID reverse-resolved through OpenClaw's session list. Assistant reply delivery to the originating channel/thread is mandatory for delivered voice turns; transcript mirroring is daemon-side best-effort.

## Required values

### `host`

Use `CLAWKIE_DAEMON_HOST_ID` from the installed configuration section above.

If it is missing or not a real host ID, stop and say:

```txt
I can’t create the voice link: missing Clawkie host ID.
```

### `session`

Use the current OpenClaw agent **actual sessionId** for `session` when it is visible in trusted runtime/session context. This is the safe transcript/session id, e.g. a UUID-like value:

```txt
c44d9502-ce71-46b1-9b15-5d548004544a
```

If both a session key and an actual sessionId are visible, put the actual sessionId in `session` and the exact colon-style key in `sessionKey`. Do not choose the colon-style key as `session` just because it is human-readable.

If the actual sessionId is not visible, use an exact current OpenClaw session key from trusted runtime/session context, e.g.:

```txt
agent:main:discord:channel:1498020851298209852
agent:main:slack:channel:C123:thread:1710000000.000100
agent:codex:acp:binding:discord:default:feedface
```

For internal web chat, the canonical main-session key is:

```txt
agent:main:main
```

Use `agent:main:main` only when the trusted runtime context is actually the OpenClaw web chat / internal main session and no actual sessionId is visible. Do not use it as a fallback for Discord, Slack, WhatsApp, Telegram, ACP, subagent, custom, direct-message, or bound sessions.

If no exact current session id/key is visible, do not invent one. For ordinary main group/channel sessions only, deriving a session-key fallback from OpenClaw’s session-key convention is acceptable when all parts are certain:

```txt
agent:<agentId>:<channel>:<chat_id>
```

Example:

```txt
agent:main:discord:channel:1498020851298209852
```

Do not derive ACP, subagent, custom, direct-message, or bound session keys unless the exact session key is visible.


## Build the URL

URL-encode all hash values. Equivalent JS:

```js
const params = new URLSearchParams();
params.set('host', CLAWKIE_DAEMON_HOST_ID);
params.set('session', sessionId);
if (sessionKey) params.set('sessionKey', sessionKey);
if (channel && target) {
  params.set('channel', channel);
  params.set('target', target);
}
if (accountId) params.set('accountId', accountId);
const url = `https://clawkietalkie.app/voice#${params.toString()}`;
```

## Response format

Keep the reply short:

```txt
Switch to voice: <url>
```

If blocked:

```txt
I can’t create the voice link: missing <field>.
```

## Example: current sessionId UUID plus visible session key

Given current actual sessionId:

```txt
c44d9502-ce71-46b1-9b15-5d548004544a
```

and current session key:

```txt
agent:main:discord:channel:1498020851298209852
```

reply:

```txt
Switch to voice: https://clawkietalkie.app/voice#host=<configured-host>&session=c44d9502-ce71-46b1-9b15-5d548004544a&sessionKey=agent%3Amain%3Adiscord%3Achannel%3A1498020851298209852&channel=discord&target=channel%3A1498020851298209852
```

Replace `<configured-host>` with `CLAWKIE_DAEMON_HOST_ID` from the installed copy of this skill.
