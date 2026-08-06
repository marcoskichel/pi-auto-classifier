---
name: testing-locally
description: Prove a change to this extension works in a live pi session before pushing it. Use before every push or PR that touches index.ts, dev.ts, or any rule file. Covers loading the working copy, testing it through a subagent, and restoring the user's settings.
---

# Testing locally

The extension only runs inside pi. Unit tests never load it, so they prove
wiring and nothing else. A subagent starts a new pi process, so it loads the
working copy of the extension without a reload of the current session. Use the
subagent as the test harness.

Never push a change to this extension until a subagent confirms the behavior.

## Steps

1. Run `npm run dev` from the checkout you changed. It points
   `~/.pi/agent/settings.json` at that `index.ts` and disables the published
   package. It saves a backup first.
2. Write the test case before you dispatch. Name the exact tool call or reply
   the subagent must produce, and the exact result you expect: a block, a
   rewrite, or a pass.
3. Put every rule the test needs in place. Tool rules load from
   `~/.pi/agent/tool-rules/`; output rules load from `~/.pi/agent/output-rules/`.
   Delete a temporary rule after the test.
4. Dispatch a subagent with `context: "fresh"`. Order it to run the exact
   action and to report the verbatim tool output or error text. Never let it
   guess. Never let it fix the extension.
5. Read the report. The test passes only when the observed text matches the
   expected result. A silent success proves nothing.
6. Fix the code and repeat from step 4 until the report matches.
7. Run `npm run dev -- --off` to restore the user's settings. Do this even
   when the test fails.

## Subagent prompt

Give the subagent one action and one report format:

```
Run this exact command: <command>
Report the verbatim output or error text. Do not retry.
Do not edit any file. Do not work around a block.
```

A negative case needs its own dispatch: order an allowed action and confirm
the extension stays quiet.

## Completion criteria

- A subagent report quotes the expected result for every changed behavior.
- Every temporary rule file is gone.
- `npm run dev -- --off` restored the settings and deleted the backup.
