# Configuration

Magpie config lives in `magpie.json`. There are two scopes; project overrides global.

- **Global:** `~/.pi/agent/magpie.json`
- **Project:** `.pi/magpie.json`

If neither file exists, Magpie falls back to `DEFAULT_CONFIG` baked into the package and also reads legacy files (`custom-modes.json`, `plan-mode.json`, `handoff.json`) from both scopes. Legacy files are only loaded when no `magpie.json` exists at either scope.

## Loading order

1. Start with `DEFAULT_CONFIG` (see `config/defaults.ts`)
2. Deep-merge global `magpie.json`
3. Deep-merge project `.pi/magpie.json`
4. If neither global nor project `magpie.json` exists, deep-merge legacy files (`custom-modes.json`, `plan-mode.json`, `handoff.json`)

Arrays are replaced, objects are merged recursively.

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startupMode` | `string` | `"smart"` | Mode to activate at session start |
| `modes` | `object` | built-ins | Mode definitions (see below) |
| `aliases` | `object` | `{fast:"rush", careful:"deep", study:"learn"}` | Short names that map to mode names |
| `subagents` | `object` | see below | Model and prompt settings for subagents |
| `handoff` | `object` | `{defaultMode:"default"}` | Handoff behavior |
| `sessions` | `object` | `{autoIndex:true, maxIndexEntries:500}` | Session indexing |
| `preferences` | `object` | `{enabled:true, maxRetrieved:20, autoExtract:false}` | Preference store |
| `memory` | `object` | see below | Life-context memory system |
| `web` | `object` | see below | Web fetch/search timeouts and model |
| `research` | `object` | see below | `/papers` and `/digest` |
| `personalAssistant` | `object` | see below | Calendar and mail scaffolding |
| `telegram` | `object` | see below | Telegram bot settings |
| `remote` | `object` | see below | Remote session dispatch |
| `webui` | `object` | `{enabled:false, port:8787, bind:"localhost"}` | Local HTTP server |
| `schedule` | `object` | `{}` | Background task notifier |

## Modes

Each key under `modes` is a mode name. The value is an object with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `statusLabel` | `string` | Text shown in the status bar |
| `model` | `string` | `provider/model-id` to use in this mode |
| `thinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Thinking depth |
| `tools` | `string[]` | Exact tool whitelist. Use `"@default"` to include the normal tool set |
| `disableTools` | `string[]` | Tools to remove without replacing the whole set |
| `prompt` | `{strategy?: "append" \| "replace", text?: string, file?: string}` | Extra system prompt injected per mode |
| `planBehavior` | `"none" \| "enter-plan"` | Whether entering this mode also enables plan mode |
| `subagents` | `{search?, oracle?, librarian?, commit?}` | Mode-level subagent overrides |

Built-in modes and their defaults:

- **smart** — `opencode-go/mimo-v2-pro`, `thinkingLevel: "high"`
- **rush** — `github-copilot/gpt-5.4-mini`, `thinkingLevel: "low"`, status `⚡ rush`
- **deep** — `github-copilot/gpt-5.3-codex`, `thinkingLevel: "xhigh"`, status `🧠 deep`
- **learn** — prompt-driven, status `🎓 learn`

User-defined modes override built-ins field-by-field.

Special aliases that always resolve to `smart`: `"default"`, `"off"`, `"build"`.

## Aliases

```json
{
  "aliases": {
    "fast": "rush",
    "careful": "deep",
    "study": "learn"
  }
}
```

Aliases are resolved before mode lookup, so `/mode fast` switches to `rush`.

## Subagents

Every subagent entry can be a plain model string (`"provider/model-id"`) or an object:

```json
{
  "model": "provider/model-id",
  "thinkingLevel": "high",
  "prompt": {
    "strategy": "append",
    "text": "Keep output factual and concise."
  }
}
```

Available roles and their defaults:

| Role | Default |
|------|---------|
| `default` | `opencode-go/minimax-m2.7` |
| `search` | `opencode-go/mimo-v2-pro` |
| `oracle` | `github-copilot/gpt-5.3-codex`, `thinkingLevel: "high"` |
| `librarian` | `opencode-go/mimo-v2-pro`, `thinkingLevel: "medium"` |
| `plan.explore` | `github-copilot/gpt-5.4-mini`, `thinkingLevel: "low"` |
| `plan.design` | `opencode-go/glm-5.1` |
| `plan.risk` | `opencode-go/mimo-v2-pro` |
| `plan.custom` | `github-copilot/gpt-5-mini` |
| `handoff` | `opencode-go/mimo-v2-pro` |
| `session` | `github-copilot/gpt-5-mini`, `thinkingLevel: "minimal"` |
| `memory` | `github-copilot/gpt-5-mini`, `thinkingLevel: "minimal"` |
| `commit` | `github-copilot/gpt-5-mini`, `thinkingLevel: "low"` |
| `schedule` | `github-copilot/gpt-5-mini`, `thinkingLevel: "low"` |
| `custom` | `github-copilot/gpt-5-mini` |

Subagent `prompt` supports `strategy: "append" | "replace"`, plus either `text` (inline) or `file` (path relative to the active config scope directory).

## Handoff

```json
{
  "handoff": {
    "defaultMode": "default"
  }
}
```

- `defaultMode` — `"default"` or `"plan"`. Controls whether handoff starts in plan mode.

## Sessions

```json
{
  "sessions": {
    "autoIndex": true,
    "maxIndexEntries": 500
  }
}
```

- `autoIndex` — automatically index sessions on startup
- `maxIndexEntries` — cap for the session index

## Preferences

```json
{
  "preferences": {
    "enabled": true,
    "maxRetrieved": 20,
    "autoExtract": false
  }
}
```

- `enabled` — allow saving and recalling preferences
- `maxRetrieved` — maximum preferences to retrieve in one call
- `autoExtract` — automatically extract preferences from conversation
- `storePath` — optional JSONL file path; supports `~` expansion. Falls back to `~/.pi/agent/magpie-preferences.jsonl`

Legacy `~/.pi/agent/magpie-memories.jsonl` is read automatically and migrated forward on the next write.

## Memory

```json
{
  "memory": {
    "rootDir": "~/.pi/agent/magpie-memory",
    "autodream": {
      "enabled": true,
      "schedule": "0 4 * * *"
    }
  }
}
```

- `rootDir` — base directory for inbox/graph/archive/digest/review files; supports `~` expansion
- `autodream.enabled` — maintain a recurring schedule entry for nightly dream runs
- `autodream.schedule` — cron expression; default is `0 4 * * *`

When autodream is enabled, Magpie creates a schedule entry that runs the `dream` tool against the most recently active Telegram thread.

## Web

```json
{
  "web": {
    "searchModel": "opencode-go/minimax-m2.7",
    "searchTimeout": 120000,
    "fetchTimeout": 30000
  }
}
```

- `searchModel` — model passed to OpenCode for `web_search`
- `searchTimeout` — ms timeout for `web_search` (default `120000`)
- `fetchTimeout` — ms timeout for `web_fetch` (default `30000`)

## Research

```json
{
  "research": {
    "papersDir": "~/magpie-papers",
    "resolverSubagent": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "low"
    }
  }
}
```

- `papersDir` — where paper metadata and digest files are stored; supports `~` expansion
- `resolverSubagent` — internal subagent for resolving paper queries in `/digest`

## Personal Assistant

```json
{
  "personalAssistant": {
    "timezone": "Europe/Amsterdam",
    "storageDir": "~/.pi/agent/personal-assistant",
    "calendar": {
      "defaultWritableCalendar": "personal"
    }
  }
}
```

- `timezone` — default timezone for calendar operations
- `storageDir` — local persistence for PA cache, drafts, and contact data; supports `~` expansion
- `calendar.defaultWritableCalendar` — iCloud calendar name/id used for event creation

## Telegram

```json
{
  "telegram": {
    "hostUrl": "http://127.0.0.1:8787",
    "allowFrom": ["123456789", "alice"],
    "models": {
      "sonnet": "anthropic/claude-sonnet-4-6"
    },
    "showToolCalls": false,
    "prompt": {
      "systemFile": "telegram/SYSTEM.md",
      "memoryFile": "telegram/MEMORY.md",
      "userFile": "telegram/USER.md",
      "customFiles": []
    }
  }
}
```

- `hostUrl` — assistant host URL the Telegram bot talks to
- `allowFrom` — list of allowed Telegram usernames or chat IDs
- `models` — named model shortcuts usable inside Telegram
- `showToolCalls` — whether to echo tool calls in Telegram chat
- `prompt.*File` — prompt files resolved relative to the active config scope directory

## Remote

```json
{
  "remote": {
    "mode": "client",
    "maxTarSize": 524288000,
    "defaultHost": "vps",
    "hosts": {
      "vps": {
        "tailscaleUrl": "http://magpie-vps:8787",
        "publicUrl": "https://magpie.example.com",
        "deviceToken": "..."
      }
    },
    "tarExclude": ["node_modules", ".pi/sessions", "dist", "build", ".venv", "__pycache__", ".git"]
  }
}
```

- `mode` — `"client"`, `"server"`, or `"both"`
- `maxTarSize` — max workspace archive size in bytes (default `524288000`)
- `defaultHost` — host name to use when no explicit host is given
- `hosts.<name>.tailscaleUrl` / `publicUrl` — reachable URLs for the host
- `hosts.<name>.deviceToken` — enrollment token for authenticated access
- `tarExclude` — paths excluded from workspace archives

## Web UI

```json
{
  "webui": {
    "enabled": false,
    "port": 8787,
    "bind": "localhost",
    "publicUrl": "https://magpie.example.com",
    "tailscaleUrl": "http://magpie-vps:8787"
  }
}
```

- `enabled` — start the HTTP server on session start
- `port` — listen port
- `bind` — `"localhost"` (loopback), `"public"` (all interfaces), `"tailscale"` (bind to host URL hostname), or a specific IP/hostname string
- `publicUrl` / `tailscaleUrl` — externally reachable URLs used for generating share links and host URL fallbacks

The Web UI is required for Telegram and remote integrations to communicate with the assistant host over HTTP.

## Schedule

```json
{
  "schedule": {
    "notifier": "macos",
    "telegram": {
      "botToken": "...",
      "chatId": "123456789"
    }
  }
}
```

- `notifier` — `"macos"`, `"telegram"`, or `"none"`
- `telegram.botToken` — can also be set in `magpie.auth.json` under `telegram.botToken`
- `telegram.chatId` — Telegram chat for schedule completion notifications
