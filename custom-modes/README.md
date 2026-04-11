# Custom Modes

A Pi extension that adds a **single-mode workflow** via `/mode`, now with Amp-like mode semantics.

> Smart/Rush/Deep mode and sub-agent concept structure are inspired by `pi-amplike`.

## What it does

- Enforces one active custom mode at a time (no mixed custom modes)
- Adds `/mode <default|build|smart|rush|deep|learn|plan>`
- Maps `default` / `build` to a **smart baseline profile** (conceptual default)
- Keeps `/mode plan` behavior aligned with `/plan` (starts plan mode) without sending `/plan` as a user message
- Makes `deep` plan-aligned by default (`planBehavior: "enter-plan"`)
- Shows **no status indicator** in default/build mode
- Adds built-in sub-agent concept scaffolding:
  - `Search` (fast local code retrieval)
  - `Oracle` (deeper analysis/planning)
  - `Librarian` (external + historical retrieval via `web_search`/`session_query`)
- Includes built-in `learn` mode

## Commands

- `/mode` — show current mode + available modes
- `/mode <name>` — switch mode
  - `/mode default`
  - `/mode build` (alias of `default`)
  - `/mode smart`
  - `/mode rush`
  - `/mode deep` (applies deep profile + enters plan mode)
  - `/mode learn`
  - `/mode plan` (starts plan mode)
- `/mode-config [global|project]` — edit mode config JSON
- `/mode-reload` — reload config from disk
- `/mode-file` — show config file paths

## Config files

- Global: `~/.pi/agent/custom-modes.json`
- Project: `.pi/custom-modes.json`

Project config overrides global config.

## Mode model fields

Each mode can now define model/profile routing fields:

- `model`: `provider/model-id`
- `thinkingLevel`: `off|minimal|low|medium|high|xhigh`
- `planBehavior`: `none|enter-plan`
  - `enter-plan` is used by built-in `deep` to align with plan workflows

Invalid/unavailable configured models gracefully fall back to the current active model.

## Sub-agent concept scaffolding

Modes can define conceptual roles under `subagents`:

- `Search`
- `Oracle`
- `Librarian`

These are **behavioral prompts**, not tool names. The extension injects concise guidance so the model uses existing tools directly (`grep/find/read`, `plan_subagent`, `web_search`, `session_query`).

## Future-ready system model placeholders

`systemModels` is supported in config/types for future expansion (not currently executed):

- `lookAt`
- `handoff`
- `titling`

## Example config (JSON)

```json
{
  "aliases": {
    "study": "learn",
    "fast": "rush",
    "careful": "deep"
  },
  "modes": {
    "rush": {
      "statusLabel": "⚡ rush",
      "model": "anthropic/claude-haiku-4-5",
      "thinkingLevel": "low",
      "tools": ["@default"]
    },
    "deep": {
      "statusLabel": "🧭 deep",
      "model": "openai-codex/gpt-5.3-codex",
      "thinkingLevel": "high",
      "planBehavior": "enter-plan"
    },
    "learn": {
      "statusLabel": "🎓 learn",
      "tools": ["@default"],
      "prompt": {
        "strategy": "append",
        "file": ".pi/modes/learn.md"
      }
    }
  }
}
```

## Fields

- `aliases`: optional name aliases
- `modes.<name>.statusLabel`: footer label for that mode
- `modes.<name>.tools`: active tools for that mode
  - use `"@default"` to include normal/default tools
- `modes.<name>.prompt.strategy`: `append` or `replace`
- `modes.<name>.prompt.file`: markdown file path (relative to config file location)
- `modes.<name>.prompt.text`: inline prompt text
- `modes.<name>.model`: model ref (`provider/model-id`)
- `modes.<name>.thinkingLevel`: reasoning level override
- `modes.<name>.planBehavior`: `none` or `enter-plan`
- `modes.<name>.subagents`: optional Search/Oracle/Librarian concept descriptors
- `modes.<name>.systemModels`: future-use placeholders (`lookAt`, `handoff`, `titling`)

## Plan mode interplay

- If plan mode is active, switching to normal custom modes is blocked until exiting plan mode.
- `/mode deep` is special: it applies deep model/thinking profile and coordinates into plan mode.
- Existing plan strict-loop behavior stays owned by `plan-mode/`.

## Session-query and handoff compatibility

- Default fallback tool discovery now includes `session_query` when installed.
- Handoff + parent-session metadata flows remain unchanged; this extension does not alter handoff session-switch logic.
- The separate `/btw` command uses the same custom-modes config files for its rush/smart/deep model routing, but it does not change the active mode state.

## Extension structure

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
