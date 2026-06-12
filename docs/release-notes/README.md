# Release notes

This directory is the source of truth for human-readable Clawkie Talkie release
notes.

Before creating or pushing a release tag, add a Markdown file named for the tag:

```text
docs/release-notes/vX.Y.Z.md
```

The release workflow fails if the matching file is missing or empty. The same
file is used for:

- the GitHub Release body
- Firebase App Distribution tester release notes

Keep notes tester-facing: summarize what changed, what testers should notice,
and any upgrade or compatibility notes. Do not include secrets, signing details,
or private credentials.

## Drafting checklist

1. Bump and verify the version as usual.
2. Draft `docs/release-notes/vX.Y.Z.md` before tagging.
3. Commit the notes with the release prep changes.
4. Merge to `master`, then create and push the matching `vX.Y.Z` tag.
