# pi-output-classifier

A [pi](https://github.com/badlogic/pi-mono) extension that checks every final assistant reply against markdown output rules. It hides the draft while the model streams, withholds replies that violate the rules, and asks the model to rewrite them. It keeps asking for rewrites until the reply passes. Classifier errors fail open.

Ships with one rule: [ASD-STE100 Simplified Technical English + TLDR](rules/ste-tldr.md) — active voice, short sentences, answer first, no filler.

## Install

```bash
pi install npm:pi-output-classifier
```

Or add a local checkout to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-output-classifier/index.ts"]
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
| `rules/` (inside this repo) | global, bundled |
| `<project>/.pi/output-rules/` | per project |

## Configuration

Classifier model, resolved in this order:

1. `PI_OUTPUT_CLASSIFIER_MODEL` env var
2. `<project>/.pi/output-classifier.json` → `{ "model": "..." }`
3. `~/.pi/agent/output-classifier.json` → `{ "model": "..." }`
4. Default: `anthropic/claude-haiku-4-5`

Set `PI_OUTPUT_CLASSIFIER_DEBUG=/path/to/log` to log classifier verdicts and errors.
