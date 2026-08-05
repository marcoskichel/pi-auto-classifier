# pi-output-classifier

A [pi](https://github.com/badlogic/pi-mono) extension that checks every final assistant reply against a set of output rules. When a reply violates the rules, the extension withholds it and asks the model to rewrite it (up to 2 attempts).

Ships with one rule: [ASD-STE100 Simplified Technical English + TLDR](rules/ste-tldr.md) — active voice, short sentences, answer first, no filler.

## How it works

1. On `message_end`, the final assistant reply is sent to a small classifier model (default: `anthropic/claude-haiku-4-5`).
2. The classifier judges the reply against all loaded rules and returns pass/fail with violations.
3. On fail, the draft is replaced with a placeholder and a hidden follow-up message asks the model to rewrite it.
4. After 2 failed rewrites it gives up and shows a warning.

Classifier errors, missing models, or missing API keys fail open — the reply passes through untouched.

## Install

Add the extension to your pi config (e.g. `~/.pi/agent/config.json`):

```json
{
  "extensions": ["/path/to/pi-output-classifier/index.ts"]
}
```

## Usage

- `/tldr` — toggle the classifier on/off
- `ctrl+alt+t` — same toggle as a shortcut
- Status bar shows the current state: `● tldr: 1 rule(s)`, `checking...`, `pass`, `fail, rewriting (1/2)`, or `○ tldr: off`

## Rules

Rules are markdown files. All `.md` files in these directories are loaded (global first, then project):

| Location | Scope |
| --- | --- |
| `rules/` (inside this repo) | global, bundled |
| `<project>/.pi/output-rules/` | per project |

Drop a new `.md` file in either directory to add a rule. See [rules/ste-tldr.md](rules/ste-tldr.md) for the format — plain prose the classifier model can judge against.

## Configuration

Classifier model, resolved in this order:

1. `PI_OUTPUT_CLASSIFIER_MODEL` env var (e.g. `openai/gpt-4o-mini`)
2. `<project>/.pi/output-classifier.json` → `{ "model": "..." }`
3. `~/.pi/agent/output-classifier.json` → `{ "model": "..." }`
4. Default: `anthropic/claude-haiku-4-5`

Debug logging: set `PI_OUTPUT_CLASSIFIER_DEBUG=/path/to/log` to append classifier verdicts and errors to a file.
