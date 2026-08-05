# pi-output-classifier

A [pi](https://github.com/badlogic/pi-mono) extension that checks every final assistant reply against a set of output rules. It hides the draft while the model streams it, withholds replies that violate the rules, and asks the model to rewrite them.

Ships with one rule: [ASD-STE100 Simplified Technical English + TLDR](rules/ste-tldr.md) — active voice, short sentences, answer first, no filler.

## How it works

1. While the model streams, the extension masks the reply text so drafts never render in the terminal. Thinking blocks and tool calls stream as usual.
2. On `message_end`, the extension sends the final reply to a small classifier model (default: `anthropic/claude-haiku-4-5`).
3. The classifier judges the reply against all loaded rules and returns pass/fail with per-rule violations.
4. On pass, the full reply renders at once.
5. On fail, a placeholder replaces the draft and a hidden follow-up message asks the model to rewrite it.
6. Each rule can force a rewrite only once per user turn. When every violated rule has spent its block, the reply passes through with a warning.

Classifier errors, missing models, or missing API keys fail open — the reply passes through untouched.

## Install

```bash
pi install npm:pi-output-classifier
```

Or from a local checkout, add it to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-output-classifier/index.ts"]
}
```

## Usage

- `/classifier` — toggle the classifier on/off
- `ctrl+alt+b` — same toggle as a shortcut
- A badge below the editor shows the current state: `● classifier (1)` idle with rule count, `…` checking, `✓` pass, `✎ rewriting`, `✗` gave up, `○ classifier off`

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
