# magpie

Magpie is a [pi](https://pi.dev) package that adds shared subagents, modes, plan mode, handoff, session intelligence, memory, web utilities, and a spinner.
![Close-up of a Black-billed Magpie on a Tree](./magpie.webp "Photo by Bejan  Adrian: https://www.pexels.com/photo/close-up-of-a-black-billed-magpie-on-a-tree-36937253/")

## Install

```bash
pi install ./
```

Or from git:

```bash
pi install git:github.com/nielsjaspers/magpie
```

## Configuration

Magpie reads one config file per scope:

- Global: `~/.pi/agent/magpie.json`
- Project: `.pi/magpie.json`

Project config overrides global config.

## Example config

```json
{
  "modes": {
    "smart": {
      "model": "opencode-go/mimo-v2-pro",
      "thinkingLevel": "high"
    },
    "rush": {
      "statusLabel": "⚡ rush",
      "model": "github-copilot/gpt-5.4-mini",
      "thinkingLevel": "low"
    },
    "deep": {
      "statusLabel": "deep",
      "model": "github-copilot/gpt-5.3-codex",
      "thinkingLevel": "xhigh"
    },
    "learn": {
      "statusLabel": "learn",
      "prompt": {
        "strategy": "append",
        "file": ".pi/modes/learn.md"
      }
    },
    "review": {
      "statusLabel": "review",
      "tools": ["read", "grep", "find", "ls", "web_search", "session_query"],
      "prompt": {
        "strategy": "append",
        "text": "Focus on risks, edge cases, and missing tests. Keep output concise."
      }
    }
  },
  "aliases": {
    "fast": "rush",
    "careful": "deep",
    "study": "learn"
  },
  "subagents": {
    "default": "opencode-go/minimax-m2.7",
    "search": "opencode-go/mimo-v2-pro",
    "oracle": { "model": "github-copilot/gpt-5.3-codex", "thinkingLevel": "high" },
    "librarian": { "model": "opencode-go/mimo-v2-pro", "thinkingLevel": "medium" },
    "plan": {
      "explore": { "model": "github-copilot/gpt-5.4-mini", "thinkingLevel": "low" },
      "design": "opencode-go/glm-5.1",
      "risk": "opencode-go/mimo-v2-pro",
      "custom": "github-copilot/gpt-5-mini"
    },
    "handoff": "opencode-go/mimo-v2-pro",
    "session": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "minimal",
      "prompt": { "strategy": "append", "file": ".pi/prompts/session-query.md" }
    },
    "memory": { "model": "github-copilot/gpt-5-mini", "thinkingLevel": "minimal" },
    "commit": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "low",
      "prompt": { "strategy": "append", "text": "Keep output factual and concise. Do not suggest follow-up changes." }
    }
  },
  "handoff": {
    "defaultMode": "default"
  },
  "sessions": {
    "autoIndex": true,
    "maxIndexEntries": 500
  },
  "memory": {
    "enabled": true,
    "maxRetrieved": 20,
    "autoExtract": false
  },
  "web": {
    "searchModel": "opencode-go/minimax-m2.7",
    "searchTimeout": 120000,
    "fetchTimeout": 30000
  }
}
```

You can copy `magpie.example.json` to `.pi/magpie.json` or `~/.pi/agent/magpie.json` as a starting point.

Subagent entries can be either a model string or an object with `model`, `thinkingLevel`, and optional `prompt`.
The `prompt` supports:
- `strategy: "append" | "replace"`
- `text: "..."` for inline prompt text
- `file: "path/to/file.md"` to load prompt text from disk

Subagent tools available to the main agent:
- `search_subagent`
- `oracle_subagent`
- `librarian_subagent`

## Included extensions

- `subagents/` — shared SDK-based subagent core
- `modes/` — `/mode`, `/magpie-config`, `/magpie-reload`
- `plan/` — strict planning loop with `plan_subagent`, `user_question`, `plan_exit`
- `btw/` — background task worker command
- `commit/` — background git commit command (see `commit/README.md`)
- `handoff/` — command + tool for starting a new session with transferred context
- `sessions/` — session indexing, `/sessions`, `get_sessions`, and `session_query` (see `sessions/README.md`)
- `memory/` — long-term memory commands and tools
- `web/` — `web_fetch` and `web_search`
- `spinner/` — random verb spinner while streaming
