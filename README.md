# Clawkie Talkie

Clawkie Talkie is a browser voice surface for OpenClaw sessions.

A local daemon runs on the user's machine, keeps private credentials local, connects to OpenClaw, and speaks to the browser over WebRTC. The hosted browser client opens voice handoff links such as:

```text
https://clawkietalkie.app/voice#host=<host>&session=<session>&channel=<channel>&target=<target>
```

## Install the daemon

For end-user Mac/Linux setup, including persistent launchd/systemd service examples, see:

- [Install the Clawkie Talkie daemon](./docs/install-daemon.md)

## Developer and protocol docs

- [Daemon README](./daemon/README.md)
- [Voice handoff protocol](./docs/voice-handoff.md)
