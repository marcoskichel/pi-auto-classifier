# pi-auto-classifier

A [pi](https://github.com/badlogic/pi-mono) extension that checks every final assistant reply against markdown output rules, and every tool call against markdown tool rules. It hides the draft while the model streams, withholds replies that violate the rules, and asks the model to rewrite them. It keeps asking for rewrites until the reply passes. Classifier errors fail open.

Ships with one rule: [ASD-STE100 Simplified Technical English + TLDR](rules/ste-tldr.md) — active voice, short sentences, answer first, no filler.

## Install

```bash
pi install npm:pi-auto-classifier
```

Or add a local checkout to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-auto-classifier/index.ts"]
}
```

## Usage

- `/classifier` — toggle on/off
- The status bar shows the current state

## Development

`npm run dev` symlinks this repo into `~/.pi/agent/npm/node_modules` and restores the installed copy on ctrl-c. Restart pi to pick up edits.

## Rules

Rules are markdown files — plain prose the classifier model can judge against. All `.md` files in these directories load:

| Location | Scope |
| --- | --- |
| `rules/` (inside this repo) | output rules, bundled |
| `~/.pi/agent/output-rules/` | output rules, all projects |
| `<project>/.pi/output-rules/` | output rules, per project |
| `~/.pi/agent/tool-rules/` | tool rules, all projects |
| `<project>/.pi/tool-rules/` | tool rules, per project |

## Tool rules

When tool rules exist, the classifier judges every tool call before it runs. A violation blocks the call and sends the violation text back to the model as an instruction, so the model changes course without asking you.

No tool rules are bundled. Write your own, for example a rule that blocks `git switch` and `git checkout -b` and orders the agent to use a worktree.

Tool rules cost one classifier call per tool call, so keep the rule set small.

## Configuration

Classifier model, resolved in this order:

1. `PI_AUTO_CLASSIFIER_MODEL` env var
2. `<project>/.pi/auto-classifier.json` → `{ "model": "..." }`
3. `~/.pi/agent/auto-classifier.json` → `{ "model": "..." }`
4. Default: `anthropic/claude-haiku-4-5`

Set `PI_AUTO_CLASSIFIER_DEBUG=/path/to/log` to log classifier verdicts and errors.
