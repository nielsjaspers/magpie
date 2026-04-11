# Custom Modes

A Pi extension that adds a **single-mode workflow** via `/mode`.

## What it does

- Enforces one active custom mode at a time (no mixed custom modes)
- Adds `/mode <default|build|learn|plan>`
- Keeps `/mode plan` behavior aligned with `/plan` (starts plan mode) without sending `/plan` as a user message
- Keeps `/mode default` and `/mode build` as normal/default mode
- Shows **no status indicator** in default/build mode
- Includes a built-in `learn` mode with learning-style system prompt instructions

## Commands

- `/mode` — show current mode + available modes
- `/mode <name>` — switch mode
  - `/mode default`
  - `/mode build` (alias of `default`)
  - `/mode learn`
  - `/mode plan` (starts plan mode)
- `/mode-config [global|project]` — edit mode config JSON
- `/mode-reload` — reload config from disk
- `/mode-file` — show config file paths

## Config files

- Global: `~/.pi/agent/custom-modes.json`
- Project: `.pi/custom-modes.json`

Project config overrides global config.

## Simple mode config (JSON)

```json
{
  "aliases": {
    "study": "learn"
  },
  "modes": {
    "learn": {
      "statusLabel": "🎓 learn",
      "tools": ["@default"],
      "prompt": {
        "strategy": "append",
        "file": ".pi/modes/learn.md"
      }
    },
    "review": {
      "statusLabel": "🧪 review",
      "tools": ["read", "grep", "find", "ls", "web_search"],
      "prompt": {
        "strategy": "append",
        "text": "Focus on review quality, risks, and test gaps."
      }
    }
  }
}
```

### Fields

- `aliases`: optional name aliases
- `modes.<name>.statusLabel`: footer label for that mode
- `modes.<name>.tools`: active tools for that mode
  - use `"@default"` to include normal/default tools
- `modes.<name>.prompt.strategy`: `append` or `replace`
- `modes.<name>.prompt.file`: markdown file path (relative to config file location)
- `modes.<name>.prompt.text`: inline prompt text

## Complex modes in code

For mode-specific behavior beyond prompts/toolsets, add a mode in:

- `custom-modes/mode-definitions.ts` → `CODE_MODES`

A code-defined mode can attach optional hooks (e.g. custom `before_agent_start`, `context`, `tool_call`) in addition to prompt/tool config.

## Extension structure

This extension is split into smaller modules:

- `custom-modes/custom-modes.ts` — command/event wiring
- `custom-modes/config.ts` — JSON config loading/merging
- `custom-modes/mode-definitions.ts` — built-in mode definitions + constants
- `custom-modes/plan-state.ts` — plan-mode state detection
- `custom-modes/types.ts` — shared types

## Starter files

This repo includes tracked starter files:

- `custom-modes/examples/custom-modes.json`
- `custom-modes/examples/learn.md`

To use them in your project:

```bash
mkdir -p .pi/modes
cp custom-modes/examples/custom-modes.json .pi/custom-modes.json
cp custom-modes/examples/learn.md .pi/modes/learn.md
```

Then run `/mode-reload` in Pi.

## Notes

- This extension does **not** modify the `plan-mode/` extension.
- `/mode plan` and `/mode default` control `plan-mode` state directly (start/stop), so you should also have the `plan-mode` extension installed.
- If plan mode is active, switching to custom modes is blocked until you exit plan mode.
- Learn mode allows multiple `TODO(human)` markers (no one-at-a-time enforcement).
