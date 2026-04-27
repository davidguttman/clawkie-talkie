# AGENTS.md - Clawkie Talkie

## Project status

- Treat this app as released as of 2026-04-27.
- Use git worktrees for new implementation work by default.
- `package.json` has `"private": true` to prevent accidental npm publication; for this repo, that is not a signal that the app is pre-release or worktree-ineligible.
- The current canonical project root is `/mnt/data/play/web/clawkie-talkie`.

## Workflow constraints

- jump.sh owns local service/container lifecycle.
- Do not run manual Docker commands.
- Do not run or kill Node servers unless David explicitly asks.
- Do not push unless David explicitly asks.
