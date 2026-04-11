# btw

A Pi extension that adds a **single background subagent command**: `/btw`.

> The command is inspired by `pi-amplike/extensions/btw.ts`, but it uses this repo's local subagent runner and respects the same `custom-modes` model/thinking configuration.

## What it does

- Adds `/btw <prompt>` as a command only
- Runs a single task in the background while you keep working
- Defaults to **rush mode** when no mode is specified
- Supports optional overrides:
  - `-mode <name>`
  - `-model <provider/modelId>`
- Uses the current conversation as background context for the subagent
- Shows live progress in an editor widget while the subagent runs
- Posts the final result back into chat as a custom message
- Preserves GitHub Copilot header behavior by passing through provider headers for subagent model calls

## Usage

```bash
/btw check whether there are any TODO comments in src/
/btw -mode smart summarize the README
/btw -mode deep inspect the latest refactor for edge cases
/btw -model anthropic/claude-haiku-4.5 count lines of code in the repo
```

## Mode behavior

`/btw` understands the same mode names used by `custom-modes`:

- `rush` (default)
- `smart`
- `deep`
- `learn`
- custom mode names from `.pi/custom-modes.json` or `~/.pi/agent/custom-modes.json`

The command resolves each mode's configured model / thinking level when available, and falls back to the current model if needed.

`plan` is intentionally not supported here, because btw is a single-task background command rather than the strict plan workflow.

## Notes

- The command does not change your active session mode.
- Background results are filtered out of the LLM context.
- `/btw` uses the same `custom-modes` config files, so mode/model changes stay aligned with the rest of the repo.
