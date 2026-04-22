# magpie

Magpie is a [pi](https://pi.dev) package that adds shared subagents, modes, plan mode, handoff, session intelligence, preferences + memory systems, web utilities, a research companion, a personal-assistant area, and a spinner.

<img
  src="./magpie.webp"
  alt="Close-up of a Black-billed Magpie on a Tree"
  title="Photo by Bejan Adrian: https://www.pexels.com/photo/close-up-of-a-black-billed-magpie-on-a-tree-36937253/"
  width="384"
/>

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
  "preferences": {
    "enabled": true,
    "maxRetrieved": 20,
    "autoExtract": false
  },
  "memory": {
    "rootDir": "~/.pi/agent/magpie-memory",
    "autodream": {
      "enabled": true,
      "schedule": "0 4 * * *"
    }
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

Preference tools:
- `save_preference`
- `recall_preferences`

Memory tools:
- `remember`
- `read_memory`
- `write_memory`
- `recall_memory`
- `dream` (manual Telegram dream: archive current thread, consolidate memory, write digest/review/graph artifacts, then queue a clean thread reset)

Research config:
- `research.papersDir` controls where papers and digest files are stored
- `research.papersDir` supports `~` expansion at runtime
- `research.resolverSubagent` configures the internal `/digest` paper resolver only

Mode config:
- `startupMode` sets the mode Magpie should start in
- `modes.<name>.disableTools` removes specific tools from that mode without replacing the whole tool set

Preferences config:
- `preferences.storePath` controls the JSONL preferences store path and supports `~` expansion via the config loader fallback path handling
- existing `~/.pi/agent/magpie-memories.jsonl` data is read automatically and migrated forward on the next write to `magpie-preferences.jsonl`

Memory config:
- `memory.rootDir` controls the root directory for the new inbox/graph/archive/digest/review memory system
- `memory.autodream.enabled` and `memory.autodream.schedule` configure nightly autodream scheduling
- when autodream is enabled, Magpie will maintain a recurring background schedule entry for nightly dream runs
- nightly autodream uses the `dream` tool against the most recently active Telegram assistant thread and sends the result through the scheduler's normal notification mechanism (Telegram, macOS, or none depending on config)

Personal assistant config:
- `personalAssistant.storageDir` controls local PA persistence and supports `~` expansion
- `personalAssistant.calendar.defaultWritableCalendar` sets the preferred writable calendar name/id for future calendar tools

Auth config:
- `semanticScholar.apiKey` is used by `/papers` for Semantic Scholar requests
- `exa.apiKey` is reserved for future integrations
- `personalAssistant.calendar` stores iCloud + ICS feed credentials/config
- `personalAssistant.mail.gmail` stores the Gmail aggregation inbox credentials
- `telegram.botToken` stores the Telegram bot token for `apps/telegram/`
- `schedule.telegram.botToken` can be set in `magpie.json`, but using `telegram.botToken` in `magpie.auth.json` is also supported for schedule notifications
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
- `preferences/` — small durable preferences/conventions stored in JSONL via `save_preference` and `recall_preferences`
- `memory/` — inbox/graph/archive/digest/review memory system scaffolding plus `remember`, `read_memory`, `write_memory`, `recall_memory`, and `dream`
- `research/` — `/papers` and `/digest` research companion (see `research/README.md`)
- `webui/` — local/remote assistant + coding host HTTP server and browser UI surface
- `remote/` — `/remote` commands plus remote session dispatch/fetch helpers and tools
- `schedule/` — `/schedule` command + tool for one-shot/recurring background tasks with notifications
- `web/` — `web_fetch` and `web_search`
- `spinner/` — random verb spinner while streaming
- `pa/` — personal-assistant scaffolding for calendar and mail integrations
- `apps/telegram/` — separate Telegram app process that reads `magpie.json` / `magpie.auth.json` and forwards non-local slash commands (e.g. `/schedule`) to Magpie
