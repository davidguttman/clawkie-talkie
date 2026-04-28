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
- Do **not** guess missing routing fields.
- Use the configured `CLAWKIE_DAEMON_HOST_ID` exactly as installed.
- If a required field is unavailable, say exactly which field is missing.

## URL contract

Generate this URL for external delivery targets:

```txt
https://clawkietalkie.app/voice#host=<host>&session=<sessionId>&channel=<channel>&target=<target>
```

For internal/webchat sessions where no external delivery target exists, omit `target`:

```txt
https://clawkietalkie.app/voice#host=<host>&session=<sessionId>&channel=webchat
```

Use hash args so `sessionId`, UUID-like values, and provider targets are not sent to web servers. Query params are compatibility-only; do not generate them unless explicitly requested.

`/voice` is the public handoff entrypoint. The browser joins the configured daemon rendezvous room first. The daemon derives the per-session voice room deterministically from `host + session`.

## Required values

### `host`

Use `CLAWKIE_DAEMON_HOST_ID` from the installed configuration section above.

If it is missing or not a real host ID, stop and say:

```txt
I can’t create the voice link: missing Clawkie host ID.
```

### `session`

Use the current OpenClaw agent session key/id. Prefer an exact session key if present in runtime/session context, e.g.:

```txt
agent:main:discord:channel:1498020851298209852
agent:main:slack:channel:C123:thread:1710000000.000100
agent:codex:acp:binding:discord:default:feedface
```

If no exact current session key/id is visible, do not invent one. For ordinary main group/channel sessions only, deriving from OpenClaw’s session-key convention is acceptable when all parts are certain:

```txt
agent:<agentId>:<channel>:<chat_id>
```

Example:

```txt
agent:main:discord:channel:1498020851298209852
```

Do not derive ACP, subagent, custom, direct-message, or bound session keys unless the exact session key is visible.

### `channel`

Use the trusted inbound metadata `channel` value, e.g.:

```json
{ "channel": "discord" }
```

If absent, use the runtime channel only if explicit. Do not infer from labels.

### `target` (optional for internal/webchat)

Use the OpenClaw message target for mirroring transcripts back to the originating conversation when an external delivery target exists.

Preferred source: `Conversation info` → `chat_id`, exactly as provided.

If this is an internal/webchat session and no external delivery target exists, do **not** block; omit `target` from the URL. The daemon will run `openclaw agent --session-id` and return the spoken reply to the phone without calling `openclaw message send`.

Examples:

```txt
channel:1498020851298209852
channel:C123
user:U123
123456789
@username
conversation:19:abc...@thread.tacv2
room:!roomId:server
```

Do not use display labels like `#general` unless that is the provider’s actual target format.

For external channels, do not guess a target. If the channel requires external delivery and no target is available, stop and say:

```txt
I can’t create the voice link: missing target.
```

## Build the URL

URL-encode all hash values. Equivalent JS:

```js
const params = new URLSearchParams();
params.set('host', CLAWKIE_DAEMON_HOST_ID);
params.set('session', sessionId);
params.set('channel', channel);
if (target) params.set('target', target);
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

## Example: Discord thread

Given:

```json
// trusted inbound metadata
{ "channel": "discord" }

// conversation info
{ "chat_id": "channel:1498020851298209852" }
```

and current session:

```txt
agent:main:discord:channel:1498020851298209852
```

reply:

```txt
Switch to voice: https://clawkietalkie.app/voice#host=<configured-host>&session=agent%3Amain%3Adiscord%3Achannel%3A1498020851298209852&channel=discord&target=channel%3A1498020851298209852
```

Replace `<configured-host>` with `CLAWKIE_DAEMON_HOST_ID` from the installed copy of this skill.
