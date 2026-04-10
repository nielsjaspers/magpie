# pi-tools

A collection of custom tools and extensions for [Pi](https://pi.dev).

These extend Pi with capabilities that do not ship by default, and are built as Pi
extensions using the extension API.

## Contents

| Directory      | Description                                      |
|----------------|--------------------------------------------------|
| `plan-mode/`   | Planning loop with subagents, user questions, and deterministic plan files |
| `web-search.ts`| Web search tool that delegates to OpenCode with Exa enabled |

## Installation

Symlink or copy into your Pi extensions directory:

```bash
# Global (all projects)
ln -sf "$(pwd)/plan-mode" ~/.pi/agent/extensions/plan-mode
ln -sf "$(pwd)/web-search.ts" ~/.pi/agent/extensions/web-search.ts

# Project-local (per repo)
mkdir -p .pi/extensions
ln -sf "$(pwd)/plan-mode" .pi/extensions/plan-mode
ln -sf "$(pwd)/web-search.ts" .pi/extensions/web-search.ts
```

Then reload Pi (`/reload`) or restart.

## Requirements

- Pi (the terminal coding agent)
- `opencode` CLI in PATH (for the web search tool)
- GitHub Copilot provider (for Copilot-specific subagent header behavior)

## Configuration

Plan mode supports global and project-local config with a 3-layer precedence:

1. Built-in defaults (ships with the extension)
2. Global config: `~/.pi/agent/plan-mode.json`
3. Project config: `.pi/plan-mode.json`

```bash
/plan-config global   # edit global config
/plan-config project  # edit project config
/plan-models          # show effective config
```

Example config:

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

## How plan mode works

1. Run `/plan <query>` to enter planning mode
2. The agent loops using `plan_subagent` and `user_question` tools
3. Parallel subagents (explore, design, risk roles) research the codebase
4. The agent writes the plan to `.pi/plans/<query-slug>.plan.md`
5. The agent calls `plan_exit`, which prompts you to:
   - Execute the plan (with `[DONE:n]` step tracking)
   - Stay in plan mode
   - Refine the plan

In plan mode, `write` and `edit` are only allowed for `.pi/plans/*.plan.md`.
Bash is restricted to read-only commands.
`web_search` is available for external research.

## License

MIT
