# Custom Clawkie Talkie stack

Clawkie Talkie defaults to the hosted stack:

- Frontend: `https://clawkietalkie.app`
- Signaling: `https://api.rambly.app`
- ICE: hosted STUN/TURN defaults
- Daemon: local user service that connects outbound

You only need a custom stack when you want to run your own browser build, signaling broker, or TURN server.

## Pieces

```text
phone browser ── HTTPS ── frontend
phone browser ── SSE/POST ── signaling ── SSE/POST ── local daemon
phone browser ◀──────────── WebRTC media/data ────────────▶ local daemon
                    STUN/TURN assists NAT traversal only
```

The repo-local signaling server is intentionally minimal. It is rambly-compatible for Clawkie Talkie and implements only:

- `GET /health`
- `GET /subscribe?id=<peerId>&room=<room>` as Server-Sent Events
- `POST /signal?room=<room>` with JSON `{ "from": "...", "to": "...", "data": {...} }`
- periodic `ping` SSE events
- in-memory room subscribers
- basic CORS/preflight support

It does **not** handle media, transcripts, persistence, auth, room ownership, or rate limiting.

## Custom signaling

Run the broker wherever both the browser and daemon can reach it:

```bash
npm run signaling
# optional local port override:
CT_SIGNALING_HOST=127.0.0.1 CT_SIGNALING_PORT=8787 npm run signaling
# explicitly expose beyond localhost:
CT_SIGNALING_HOST=0.0.0.0 CT_SIGNALING_PORT=8787 npm run signaling
```

The repo server binds to `127.0.0.1` by default. Set `CT_SIGNALING_HOST=0.0.0.0` only when you are intentionally exposing it behind your own HTTPS/proxy/firewall setup.

Do not put secrets in this service. Treat peer IDs and room names as bearer routing material and place the service behind normal HTTPS infrastructure if exposed beyond localhost. The reference server includes basic id/room length limits and subscriber caps, but public deployments still need normal abuse controls.

## Daemon transport configuration

Hosted defaults stay in effect when these are unset.

CLI flags:

```bash
npm run daemon -- \
  --signal-server https://signal.example.com \
  --ice-servers-json '[{"urls":"stun:stun.example.com:3478"}]'
```

Environment:

```bash
CT_SIGNAL_SERVER=https://signal.example.com
CT_ICE_SERVERS_JSON='[{"urls":"turn:turn.example.com:3478","username":"clawkie","credential":"change-me"}]'
```

CLI flags override environment values. Invalid ICE JSON fails daemon startup before it connects.

## Frontend transport configuration

Vite build-time env:

```bash
VITE_SIGNAL_SERVER=https://signal.example.com
VITE_ICE_SERVERS_JSON='[{"urls":"turn:turn.example.com:3478","username":"clawkie","credential":"change-me"}]'
```

If `VITE_ICE_SERVERS_JSON` is invalid, the browser logs a warning and falls back to the hosted ICE defaults.

## Coturn

TURN is standard coturn; Clawkie Talkie does not ship a custom TURN server. A minimal coturn shape:

```conf
listening-port=3478
fingerprint
lt-cred-mech
realm=turn.example.com
user=clawkie:change-me
no-multicast-peers
no-cli
```

For production, add TLS (`tls-listening-port=5349`, certificates), firewall rules, rotation/ephemeral credentials, monitoring, and abuse controls appropriate for your network.

Sample ICE JSON for that coturn user:

```json
[
  { "urls": "stun:turn.example.com:3478" },
  { "urls": "turn:turn.example.com:3478", "username": "clawkie", "credential": "change-me" }
]
```

## Security boundary

The signaling server only relays rendezvous messages. Audio, transcripts, OpenClaw session access, and provider credentials stay on the local daemon/OpenClaw side. A custom public signaling or TURN deployment still needs normal internet-service protections: HTTPS, abuse limits, logging policy, credential rotation, and network access controls.
