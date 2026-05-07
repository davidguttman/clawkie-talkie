# AGENTS.md - Clawkie Talkie

## Project status

- Treat this app as released as of 2026-04-27.
- Use git worktrees for new implementation work by default.
- **Worktree location is mandatory:** all Clawkie Talkie worktrees must live under `/mnt/data/play/web/clawkie-talkie/.worktrees/` (or the equivalent `/home/dguttman/play/web/clawkie-talkie/.worktrees/` symlink path). Do not create or use sibling directories such as `/mnt/data/play/web/clawkie-talkie-*`, `/home/dguttman/play/web/clawkie-talkie-*`, or `/mnt/data/play/web/clawkie-talkie-worktrees/*`.
- Before creating or using a worktree, verify the resolved absolute path starts with `/mnt/data/play/web/clawkie-talkie/.worktrees/`.
- `package.json` has `"private": true` to prevent accidental npm publication; for this repo, that is not a signal that the app is pre-release or worktree-ineligible.
- The current canonical project root is `/mnt/data/play/web/clawkie-talkie`.

## Workflow constraints

- jump.sh owns local service/container lifecycle.
- Do not run manual Docker commands.
- Do not run or kill Node servers unless David explicitly asks.
- Do not push unless David explicitly asks.

## Compatibility invariant

- The hosted browser client can update before a user's installed local daemon. Treat **new client + old daemon** as the primary compatibility direction.
- Client changes must gracefully degrade when daemon-side protocol messages, fields, or capabilities are missing.
- New daemon protocol additions should be additive/optional whenever possible; do not require a coordinated client+daemon upgrade for core voice flow.
- When changing rendezvous, reconnect, session-list, STT, TTS, or playback protocol behavior, add or update tests that prove a newer client still works against an older daemon shape.
