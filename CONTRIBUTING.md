# Contributing

## Contributing a rule

Rules live in [`rules/`](rules/). `/classifier-install` lists that directory live from GitHub, so a merged rule PR is available to every user immediately.

A rule is one markdown file, plain prose the classifier model can judge against:

- File name: short, lowercase, `.md` (e.g. `tldr.md`). The name is the rule's identity in menus and violation reports.
- Start with a `# Heading` naming the rule, then the requirements as short bullets.
- Judge only observable text. Avoid rules that need context the classifier does not see.
- If the rule is a matter of degree, add `once:` frontmatter so it caps at one failure per turn (see the README).
- Keep it small: every rule rides along on every classifier call.

Test it before opening the PR: drop the file in `~/.pi/agent/output-rules/`, run pi, and confirm it withholds a violating reply and passes a compliant one.

## Working on the extension

`npm run dev` runs pi with this checkout loaded through `--extension`. An installed copy of the package is moved aside for the run and restored on exit. `~/.pi/agent/settings.json` is never modified. Restart pi to pick up edits.

`npm run check` runs types, lint, and the comment check. `npm test` runs unit tests.
