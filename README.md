# magpie

Magpie is a [pi](https://pi.dev) package that adds shared subagents, modes, plan mode, handoff, session intelligence, memory, web utilities, a research companion, and a spinner.
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

Magpie can also read an optional auth file per scope for provider API keys:

- Global: `~/.pi/agent/magpie.auth.json`
- Project: `.pi/magpie.auth.json`

Project auth overrides global auth.

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
  },
  "research": {
    "papersDir": "~/personal/magpie-papers",
    "resolverSubagent": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "low"
    }
  }
}
```

You can copy `magpie.example.json` to `.pi/magpie.json` or `~/.pi/agent/magpie.json` as a starting point.
You can copy `magpie.auth.example.json` to `.pi/magpie.auth.json` or `~/.pi/agent/magpie.auth.json` for provider API keys.

Subagent entries can be either a model string or an object with `model`, `thinkingLevel`, and optional `prompt`.
The `prompt` supports:
- `strategy: "append" | "replace"`
- `text: "..."` for inline prompt text
- `file: "path/to/file.md"` to load prompt text from disk

Subagent tools available to the main agent:
- `search_subagent`
- `oracle_subagent`
- `librarian_subagent`

Research config:
- `research.papersDir` controls where papers and digest files are stored
- `research.papersDir` supports `~` expansion at runtime
- `research.resolverSubagent` configures the internal `/digest` paper resolver only

Auth config:
- `semanticScholar.apiKey` is used by `/papers` for Semantic Scholar requests
- `exa.apiKey` is reserved for future integrations
- auth values live in `magpie.auth.json`, not `magpie.json`

Research commands:
- `/papers [-limit <1-20>] <query>`
- `/digest <query>`

## Auth example

```json
{
  "semanticScholar": {
    "apiKey": "your-semantic-scholar-api-key"
  },
  "exa": {
    "apiKey": "your-exa-api-key"
  }
}
```

## Included extensions

- `subagents/` — shared SDK-based subagent core
- `modes/` — `/mode`, `/magpie-config`, `/magpie-reload`
- `plan/` — strict planning loop with `plan_subagent`, `user_question`, `plan_exit`
- `btw/` — background task worker command
- `commit/` — background git commit command (see `commit/README.md`)
- `handoff/` — command + tool for starting a new session with transferred context
- `sessions/` — session indexing, `/sessions`, `get_sessions`, and `session_query` (see `sessions/README.md`)
- `memory/` — long-term memory commands and tools
- `research/` — `/papers` and `/digest` research companion (see `research/README.md`)
- `web/` — `web_fetch` and `web_search`
- `spinner/` — random verb spinner while streaming
