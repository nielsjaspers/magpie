# Magpie Telegram App

A separate Telegram process for Magpie.

This app currently uses a first shared Magpie runtime slice for assistant sessions, and it already uses:

- `magpie.json`
- `magpie.auth.json`

for its Telegram-specific settings.

## Current status

This is the first in-repo embed step.

It is intentionally still thin and simple so you can test it locally quickly.
It now persists assistant sessions per Telegram chat through a shared runtime module.
A later step will move it fully onto the remote Magpie host API/runtime layer.

## Config

Telegram reads Magpie config/auth from the normal Magpie locations:

- Global config: `~/.pi/agent/magpie.json`
- Project config: `.pi/magpie.json`
- Global auth: `~/.pi/agent/magpie.auth.json`
- Project auth: `.pi/magpie.auth.json`

### Example config

```json
{
  "telegram": {
    "allowFrom": ["123456789", "alice"],
    "models": {
      "sonnet": "anthropic/claude-sonnet-4-6",
      "mimop": "opencode-go/mimo-v2-pro"
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

### Example auth

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

Prompt files are resolved relative to the active Magpie config scope directory:

Built-in Telegram commands (`/help`, `/model`, `/session`, etc.) are handled by the bot.
All other slash commands (for example `/schedule ...`) are forwarded to Magpie.

- project first (`.pi/...`)
- then global (`~/.pi/agent/...`)

## Session persistence

Telegram assistant sessions are currently stored under the Magpie personal-assistant storage dir:

```text
<personalAssistant.storageDir>/telegram/
```

This includes:

- `sessions/` for Pi session JSONL files
- `thread-sessions.json` for Telegram chat -> session file mapping

## Run locally

```bash
cd apps/telegram
bun install
bun run dev
```
