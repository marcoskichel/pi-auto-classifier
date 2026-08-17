# pi-auto-classifier

A [pi](https://github.com/badlogic/pi-mono) extension that checks every final assistant reply against markdown output rules, and every tool call against markdown tool rules. It hides the draft while the model streams, withholds replies that violate the rules, and asks the model to rewrite them. It keeps asking for rewrites until the reply passes. Classifier errors fail open.

No rules load by default. Install rules from the [catalog](rules/) with `/classifier-install`, or write your own.

## Install

```bash
pi install npm:pi-auto-classifier
```

Or add a local checkout to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-auto-classifier/src/index.ts"]
}
```

## Usage

- `/classifier-install` — pick a rule from the catalog in this repo and install it to `~/.pi/agent/output-rules/`. Uninstall by deleting the file.
- `/classifier` — open the toggle menu: the first row turns the whole classifier on/off, each other row turns one rule on/off. Esc closes it.
- The status bar shows the current state and the number of active rules
- Toggles last for the session. Press `s` in the menu to save them to `~/.pi/agent/auto-classifier.json`, so new sessions start with the same rules off.
- A withheld reply leaves one muted line in the chat: `Withheld by classifier. rule: <rules>`. Press the expand key (`ctrl+o` by default) to read the reasons.

## Rules

Rules are markdown files — plain prose the classifier model can judge against. All `.md` files in these directories load:

| Location | Scope |
| --- | --- |
| `~/.pi/agent/output-rules/` | output rules, all projects |
| `<project>/.pi/output-rules/` | output rules, per project |
| `~/.pi/agent/tool-rules/` | tool rules, all projects |
| `<project>/.pi/tool-rules/` | tool rules, per project |

### A rule that fails only once

Some rules are a matter of degree, so the model and the judge can disagree forever. Optional YAML frontmatter caps a rule at one failure per user turn:

```markdown
---
once: Make your reply much shorter, like a TLDR, remove trivia and all unnecessary details
---

# TLDR
...
```

The first violation asks for a rewrite and sends the `once` text as the reason, instead of whatever the judge wrote. Later violations of that rule are dropped for the rest of the turn, so the reply ships when no other rule fails. The next user message re-arms the rule. Write `once:` with no text to cap the rule but keep the judge's own reason. The catalog's TLDR rule uses this.

## Tool rules

When tool rules exist, the classifier judges every tool call before it runs. A violation blocks the call and sends the violation text back to the model as an instruction, so the model changes course without asking you.

No tool rules are bundled. Write your own, for example a rule that blocks `git switch` and `git checkout -b` and orders the agent to use a worktree.

Tool rules cost one classifier call per tool call, so keep the rule set small.

### The user overrides a rule

A block runs a second check. The classifier reads your last message. It passes the call when you asked for that action yourself, so "switch branch" performs the switch even under a rule that blocks branch switches.

A rule can refuse the override with one line:

```markdown
Block this action even when the user asks for it.
```

## Configuration

Classifier model, resolved in this order:

1. `PI_AUTO_CLASSIFIER_MODEL` env var
2. `<project>/.pi/auto-classifier.json` → `{ "model": "..." }`
3. `~/.pi/agent/auto-classifier.json` → `{ "model": "..." }`
4. Default: `anthropic/claude-haiku-4-5`

Set `PI_AUTO_CLASSIFIER_DEBUG=/path/to/log` to log classifier verdicts and errors.

## Contributing a rule

The catalog is the `rules/` directory in this repo. `/classifier-install` lists it live from GitHub, so a merged rule is available to everyone immediately, without a package release. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Code lives in `src/`: `index.ts` (the extension), `test.ts` (unit tests), `dev.ts` (local dev runner), `no-comments.ts` (lint script). See [CONTRIBUTING.md](CONTRIBUTING.md).
