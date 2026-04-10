# Plan Mode (custom)

Project-local planning loop extension with subagents + user questions + deterministic plan files.

## Features

- `plan_subagent` with richer roles:
  - `explore` (codebase recon)
  - `design` (approach/tradeoffs)
  - `risk` (failure modes + validation)
  - `custom`
- `user_question` with:
  - freeform questions
  - single-choice + custom fallback
  - multi-select (comma-separated indices) + custom text
- Strict planning loop guard:
  - in plan mode, turns must end with `user_question` or `plan_exit`
- Deterministic plan file path:
  - `.pi/plans/<query-slug>.plan.md`
- Plan finalize flow preserved:
  - Execute the plan
  - Stay in plan mode
  - Refine the plan
- Execution progress tracking via `[DONE:n]`

## Commands

- `/plan [seed]` — toggle plan mode (optional seed controls slug)
- `/plan-file` — show active plan file
- `/plan-models` — show global/project/effective subagent model mapping
- `/plan-config [global|project]` — edit global or project config
- `/todos` — show execution progress
- `Ctrl+Alt+P` — toggle plan mode

## Plan Mode Restrictions

- Allowed tools in plan mode:
  - `read`, `bash`, `grep`, `find`, `ls`, `web_search`
  - `write`, `edit` **only** for `.pi/plans/*.plan.md`
  - `plan_subagent`, `user_question`, `plan_exit`
- Bash is allowlisted to read-only commands.

`web_search` is expected to come from your existing global extension (`~/.pi/agent/extensions/web-search.ts`).

Subagents do **not** inherit the main agent model by default; set models via config.

Config precedence:
1. Global config: `~/.pi/agent/plan-mode.json`
2. Project config: `.pi/plan-mode.json`

Project config overrides global config.

Example config schema (same for both):

```json
{
  "subagentModels": {
    "default": "github-copilot/gpt-5.4-mini",
    "explore": "github-copilot/gemini-3-flash-preview",
    "design": "github-copilot/gemini-3-flash-preview",
    "risk": "github-copilot/claude-haiku-4-5",
    "custom": "github-copilot/gpt-5-mini"
  }
}
```

## GitHub Copilot subagents

OpenCode marks subagent requests with `x-initiator: agent` for Copilot.
This extension applies that behavior to spawned subagent subprocesses, and also sets `Openai-Intent: conversation-edits` in that subprocess context.

## Typical flow

1. `/plan <query>`
2. Agent loops with `plan_subagent` and `user_question`
3. Agent writes/updates `.pi/plans/<slug>.plan.md`
4. Agent calls `plan_exit`
5. You choose execute/stay/refine
