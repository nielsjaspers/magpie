# Magpie Telegram App

A separate Telegram process for Magpie.

This app currently embeds Pi SDK sessions directly, but it already uses:

- `magpie.json`
- `magpie.auth.json`

for its Telegram-specific settings.

## Current status

This is the first in-repo embed step.

It is intentionally still thin and simple so you can test it locally quickly.
A later step will move it over to the shared Magpie host API/runtime layer.

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

- project first (`.pi/...`)
- then global (`~/.pi/agent/...`)

## Run locally

```bash
cd apps/telegram
bun install
bun run dev
```
