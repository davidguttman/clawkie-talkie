# Clawkie Talkie Agent Install — Upgrade / Repair

Use this flow when `CLAWKIE_SOURCE_DIR` already exists, the daemon has run before, the handoff skill is already installed, or source/dependencies are broken.

Goal: refresh code/docs while preserving daemon identity, installed skill configuration, and persistence behavior.

Use this flow for a daemon protocol/capability mismatch. The browser client is current by definition, so do not ask the user to change the hosted link or browser app; update the installed daemon while preserving local identity.

## Preserve before changing files

Do **not** delete or replace the source directory until you have preserved and verified:

- repo-root `.env`
- existing `DAEMON_PEER_ID`
- installed OpenClaw skill's `CLAWKIE_DAEMON_HOST_ID`
- active persistence mechanism: launchd or `systemd --user`

The preserved daemon `DAEMON_PEER_ID` and installed skill `CLAWKIE_DAEMON_HOST_ID` must stay identical after the upgrade.

```bash
: "${CLAWKIE_SOURCE_DIR:?set to existing Clawkie Talkie source directory}"
cd "$CLAWKIE_SOURCE_DIR"

test -f .env || { echo "missing .env; stop and ask before reinstalling" >&2; exit 1; }
chmod 600 .env
DAEMON_PEER_ID=$(awk -F= '/^DAEMON_PEER_ID=/{print $2; exit}' .env)
test -n "$DAEMON_PEER_ID" || { echo "missing DAEMON_PEER_ID in .env; stop before changing files" >&2; exit 1; }
```

Do not generate a new daemon peer ID unless the user explicitly asks to create a new identity.

## Locate the current install

Prefer the configured service command/path if it exists. Otherwise use the known install path under the OpenClaw workspace.

Check the installed skill and current service before touching files:

```bash
configured_host=$(awk -F'= ' '/^- CLAWKIE_DAEMON_HOST_ID = / {gsub(/`/, "", $2); print $2; exit}' "$CLAWKIE_SKILL_DIR/SKILL.md" 2>/dev/null || true)
test "$configured_host" = "$DAEMON_PEER_ID" || {
  echo "installed skill host ID does not match daemon .env; stop and repair deliberately" >&2
  exit 1
}
```

## Stop only Clawkie Talkie service

Stop only the Clawkie Talkie user service while replacing files:

- macOS: unload/stop the `app.clawkietalkie.daemon` LaunchAgent for the current user.
- Linux: `systemctl --user stop clawkie-talkie.service`.

Do not stop unrelated OpenClaw, browser, Docker, or system services.

## Refresh source safely

If the source directory is a git checkout and has no relevant local changes, use a fast-forward update:

```bash
git fetch --prune
git pull --ff-only
```

If the source came from a ZIP or git state is unclear, download a fresh ZIP into a temporary directory and copy it over the existing source while preserving local runtime files:

```bash
: "${CLAWKIE_SOURCE_DIR:?set to existing Clawkie Talkie source directory}"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

curl -L -o clawkie-talkie.zip https://github.com/davidguttman/clawkie-talkie/archive/HEAD.zip
unzip -q clawkie-talkie.zip
extracted_dir=$(find . -maxdepth 1 -type d -name 'clawkie-talkie-*' | head -n 1)

rsync -a --delete \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude '.git' \
  "$extracted_dir"/ "$CLAWKIE_SOURCE_DIR"/

cd "$CLAWKIE_SOURCE_DIR"
```

## Reinstall dependencies

```bash
npm install
```

## Reinstall/update the skill

Copy the refreshed source skill into the runtime skills directory, then patch the installed copy using the preserved `DAEMON_PEER_ID`.

Never leave the installed skill with `<CONFIGURE_DAEMON_PEER_ID>` after an upgrade.

The installed skill's `CLAWKIE_DAEMON_HOST_ID` must equal the daemon `.env` `DAEMON_PEER_ID`.

## Restart and verify

Restart only the Clawkie Talkie user service, then run the required checks in [`agent-install-verification.md`](agent-install-verification.md).

If verification fails, keep the preserved `.env` and report the failing command/output. Do not retry with a new host ID.
