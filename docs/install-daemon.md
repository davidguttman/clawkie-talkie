# Install the Clawkie Talkie daemon

This guide is for installing the Clawkie Talkie daemon on a user's own Mac or Linux machine so it can keep running after login/reboot.

The daemon is the private local side of Clawkie Talkie. It holds the xAI key, connects to OpenClaw, joins the Clawkie signaling room, and talks to the browser over WebRTC. The browser never receives your xAI key.

## Supported platforms

Primary support:

- macOS on Apple Silicon or Intel
- Linux on x64 or arm64

Windows native packages exist for the WebRTC dependency, but this repo does not currently document or verify a Windows daemon install path. Use macOS or Linux unless Windows support has been validated for your setup.

## What you need

- A machine that can stay online while you want voice handoff to work.
- Node.js and npm. Use a current Node release; Node 22 LTS or newer is recommended.
- `curl` and `unzip` for downloading the source ZIP.
- OpenClaw installed, configured, and available on `PATH` as `openclaw` for the same user that runs the daemon.
- An xAI API key for STT/TTS and OpenClaw turns.
- Outbound network access to the signaling service, xAI, and any OpenClaw services you use.

The daemon uses `@roamhq/wrtc` for native WebRTC. Its package includes prebuilt native packages for common macOS/Linux architectures. If your platform cannot use a prebuild, `npm install` may need native build tools:

- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Debian/Ubuntu: `python3`, `make`, `g++`
- Fedora/RHEL: `python3`, `make`, `gcc-c++`

## Install from source

The currently supported install path is from this repo. There is no published npm package installer for the daemon yet.

Download the latest source ZIP from GitHub into the installing agent's own OpenClaw workspace. Do **not** create a separate generic home-directory workspace and do **not** copy paths from this repo author's machine. Use the active OpenClaw workspace for the machine being installed; if you cannot determine it, stop and ask.

```bash
OPENCLAW_WORKSPACE="/absolute/path/to/this-openclaw-workspace"
CLAWKIE_SOURCE_DIR="$OPENCLAW_WORKSPACE/external/clawkie-talkie"

mkdir -p "$(dirname "$CLAWKIE_SOURCE_DIR")"
cd "$(dirname "$CLAWKIE_SOURCE_DIR")"
curl -L -o clawkie-talkie.zip \
  https://github.com/davidguttman/clawkietalkie/archive/HEAD.zip
unzip -q clawkie-talkie.zip
extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkietalkie-*' | head -n 1)
rm -rf "$CLAWKIE_SOURCE_DIR"
mv "$extracted_dir" "$CLAWKIE_SOURCE_DIR"
rm clawkie-talkie.zip
cd "$CLAWKIE_SOURCE_DIR"
npm install
```

## Configure the daemon

Create a repo-root `.env` file. Do not commit it or share it.

```bash
cd "$CLAWKIE_SOURCE_DIR"
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```env
# Required. Keep this secret.
XAI_API_KEY=xai-...

# Required for a persistent install. Generate once and keep it stable.
DAEMON_PEER_ID=REPLACE_WITH_A_RANDOM_UUID

# Optional. The daemon defaults to https://clawkietalkie.app — only set this
# to override the default client deployment.
# CT_CLIENT_ORIGIN=

# Optional examples.
CT_STT_LANGUAGE=en
CT_THREAD_ID=
```

Generate the stable daemon ID with Node:

```bash
node -e "console.log('DAEMON_PEER_ID=' + require('node:crypto').randomUUID())"
```

Copy the printed `DAEMON_PEER_ID=...` line into `.env`.

### Why `DAEMON_PEER_ID` should be stable

`DAEMON_PEER_ID` is the daemon's rendezvous room ID. If it is missing, the daemon generates a fresh ID every time it starts. That is fine for development, but bad for an installed daemon because old voice links stop pointing at the running daemon after every restart.

Treat the ID as private-ish: it is not your xAI key, but it does identify the room your daemon listens on. Do not commit it, post it in public issues, or put it in screenshots. It is safe for Clawkie voice handoff links to include it. A stable ID also gives future browser pairing/resume features something durable to remember.

## Run it manually once

From the repo root:

```bash
cd "$CLAWKIE_SOURCE_DIR"
npm run daemon
```

A healthy startup prints lines like:

```text
[peer] subscribed to rendezvous room as <your-daemon-peer-id>
Session:  dev-local
Peer ID:  <your-daemon-peer-id>
Join URL: https://clawkietalkie.app/?host=<your-daemon-peer-id>
Waiting for phone…
```

Leave this terminal running for the first manual test. Press `Ctrl-C` to stop it.

The printed `Join URL` proves the daemon has a host ID and client origin. Real voice handoff links are usually created by OpenClaw and include the current session and delivery target, for example:

```text
https://clawkietalkie.app/voice#host=<host>&session=<session>&channel=<channel>&target=<target>
```

## Keep it running on macOS with launchd

Use a per-user LaunchAgent. Replace `/ABSOLUTE/PATH/TO/CLAWKIE_TALKIE` with the real absolute `CLAWKIE_SOURCE_DIR` path from this install.

Create `~/Library/LaunchAgents/app.clawkietalkie.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.clawkietalkie.daemon</string>

  <key>WorkingDirectory</key>
  <string>/ABSOLUTE/PATH/TO/CLAWKIE_TALKIE</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /ABSOLUTE/PATH/TO/CLAWKIE_TALKIE &amp;&amp; npm run daemon</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/HOME/Library/Logs/clawkie-talkie.out.log</string>

  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/HOME/Library/Logs/clawkie-talkie.err.log</string>
</dict>
</plist>
```

Load and start it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.clawkietalkie.daemon.plist
launchctl kickstart -k gui/$(id -u)/app.clawkietalkie.daemon
```

Check status and logs:

```bash
launchctl print gui/$(id -u)/app.clawkietalkie.daemon
tail -f ~/Library/Logs/clawkie-talkie.out.log ~/Library/Logs/clawkie-talkie.err.log
```

Stop or reload after edits:

```bash
launchctl bootout gui/$(id -u)/app.clawkietalkie.daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.clawkietalkie.daemon.plist
launchctl kickstart -k gui/$(id -u)/app.clawkietalkie.daemon
```

If you installed Node with `nvm`, `asdf`, or another shell-managed tool, launchd may not find `npm`. Run `command -v npm`, then replace `npm run daemon` in the plist with the absolute `npm` path if needed.

## Keep it running on Linux with systemd user services

Use a per-user systemd service. This starts after your user session starts. Replace `/ABSOLUTE/PATH/TO/CLAWKIE_TALKIE` with the real absolute `CLAWKIE_SOURCE_DIR` path from this install.

Create `~/.config/systemd/user/clawkie-talkie.service`:

```ini
[Unit]
Description=Clawkie Talkie daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/ABSOLUTE/PATH/TO/CLAWKIE_TALKIE
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npm run daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clawkie-talkie.service
```

Check status and logs:

```bash
systemctl --user status clawkie-talkie.service
journalctl --user -u clawkie-talkie.service -f
```

Restart after config changes:

```bash
systemctl --user restart clawkie-talkie.service
```

User services normally start when you log in. If you need the daemon to start at boot before you log in, enable lingering for your account:

```bash
sudo loginctl enable-linger "$USER"
```

## Install the OpenClaw voice handoff skill

The daemon alone is not enough for voice handoff. OpenClaw also needs the `clawkie-voice-handoff` skill so a user can ask an agent to switch the current conversation to voice.

If an agent is performing the install, use [Agent install instructions](../AGENT-INSTALL.md). That guide includes copying `openclaw/clawkie-voice-handoff/SKILL.md` into the runtime skills directory and patching the installed copy with this machine's stable `DAEMON_PEER_ID`.

Do not put the user's `DAEMON_PEER_ID` into the source-controlled skill file. Only the runtime-installed copy should contain the machine-specific host ID.

## Verify the install

After starting the daemon manually or as a service:

1. Check the service status:
   - macOS: `launchctl print gui/$(id -u)/app.clawkietalkie.daemon`
   - Linux: `systemctl --user status clawkie-talkie.service`
2. Check logs for:
   - `subscribed to rendezvous room as <DAEMON_PEER_ID>`
   - `Peer ID: <DAEMON_PEER_ID>`
   - `Waiting for phone…`
3. Confirm the printed peer ID matches the `DAEMON_PEER_ID` in `.env`.
4. Confirm the OpenClaw `clawkie-voice-handoff` skill is installed and configured with the same host ID.
5. From OpenClaw, request a Clawkie Talkie voice handoff link and open it in a browser.
6. The browser should reach the voice UI instead of a bad-session error, and the daemon logs should show WebRTC/rendezvous activity.

There is no inbound HTTP port for the daemon to expose. It reaches the signaling service over outbound HTTPS and establishes WebRTC from there.

## Update later

If installed from a ZIP, download the latest ZIP and refresh the source folder. Preserve your `.env` (it lives in the repo root and is not in the ZIP, but make a backup if you keep it elsewhere):

```bash
: "${CLAWKIE_SOURCE_DIR:?set this to the existing Clawkie Talkie source directory}"
cd "$(dirname "$CLAWKIE_SOURCE_DIR")"
curl -L -o clawkie-talkie.zip \
  https://github.com/davidguttman/clawkietalkie/archive/HEAD.zip
cp "$CLAWKIE_SOURCE_DIR/.env" /tmp/clawkie-talkie.env.bak
unzip -q -o clawkie-talkie.zip
extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkietalkie-*' | head -n 1)
rm -rf "$CLAWKIE_SOURCE_DIR"
mv "$extracted_dir" "$CLAWKIE_SOURCE_DIR"
mv /tmp/clawkie-talkie.env.bak "$CLAWKIE_SOURCE_DIR/.env"
rm clawkie-talkie.zip
cd "$CLAWKIE_SOURCE_DIR"
npm install
```

Then restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/app.clawkietalkie.daemon

# Linux
systemctl --user restart clawkie-talkie.service
```

## Troubleshooting

### `XAI_API_KEY env var is required`

The daemon did not find your xAI key. Make sure `.env` is in the repo root, contains `XAI_API_KEY=...`, and that the daemon is started from the repo root.

### The host ID changes after reboot

Set `DAEMON_PEER_ID` in `.env`. Generate it once and keep it stable. If you delete or change it, old links and future remembered browser pairings will point at the old ID.

### `openclaw_unavailable` or `openclaw: command not found`

The daemon user cannot run the OpenClaw CLI. Install OpenClaw for that user, or fix the service `PATH` so `openclaw` is available.

Check manually:

```bash
command -v openclaw
openclaw status
```

### OpenClaw auth or gateway errors

The daemon found `openclaw`, but OpenClaw is not authenticated, configured, or running for that user. Fix OpenClaw first, then restart the daemon.

### `npm install` fails on `@roamhq/wrtc`

Use Node 22 LTS or newer, then reinstall:

```bash
rm -rf node_modules
npm install
npm rebuild @roamhq/wrtc
```

If it still builds from source and fails, install native build tools for your OS. On macOS, run `xcode-select --install`. On Debian/Ubuntu, install `python3 make g++`.

### The service starts manually but fails under launchd/systemd

This is usually a path or working-directory problem.

- Use absolute paths in the launchd plist.
- Check the service logs.
- Make sure `npm`, `node`, and `openclaw` are available to the service user.
- If using `nvm` or `asdf`, prefer absolute binary paths in the service file.

### The browser shows a bad-session error

The link is missing required handoff fields. A real handoff URL needs `host`, `session`, `channel`, and `target`. The daemon's printed host-only URL is only a startup hint.

### Signaling or WebRTC never connects

Check outbound network access to the signaling server. By default, both daemon and browser use `https://api.rambly.app` plus the configured STUN/TURN servers. Corporate firewalls, proxies, or blocked UDP/TURN traffic can prevent a WebRTC connection.

### Port conflicts

The daemon itself does not listen on an inbound HTTP port. If you see a port conflict, it is probably from a separate local dev client or another OpenClaw-related service, not the daemon install path in this guide.
