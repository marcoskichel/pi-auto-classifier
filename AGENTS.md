# pi-auto-classifier

IMPORTANT: Invoke the `testing-locally` skill before you push any change to
`index.ts`, `dev.ts`, or a rule file. Unit tests never load the extension, so a
live subagent test is the only proof.

## Commands

- `npm run check` — types, lint, comment check.
- `npm test` — unit tests.
- `npm run dev` — run pi with this checkout loaded. Never edits settings.json.

## Rules

- No comments in `index.ts`. `no-comments.ts` enforces it. A `ponytail:` prefix
  is the only exception.
- Never switch branches in this checkout. Create a worktree under `_worktrees/`.
