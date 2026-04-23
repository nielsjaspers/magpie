# Memory + Preferences Setup

This doc explains how to try Magpie's new:
- `preferences/` JSONL store
- `memory/` inbox + graph + archive + digest + review system
- manual Telegram `dream`
- nightly `autodream`

## What exists right now

### Preferences
Small durable facts and conventions:
- `save_preference`
- `recall_preferences`

Stored by default in:
- `~/.pi/agent/magpie-preferences.jsonl`

Legacy compatibility:
- old `~/.pi/agent/magpie-memories.jsonl` is still read automatically
- once you save a new preference, data is written forward to the new preferences file

### Memory
Life-context memory system:
- `remember`
- `read_memory`
- `write_memory`
- `recall_memory`
- `dream`

Stored by default in:
- `~/.pi/agent/magpie-memory/`

Expected structure:

```text
~/.pi/agent/magpie-memory/
  inbox/
  graph/
  archive/
    telegram/
    dreams/
    sessions/
  digest/
    daily/
  review/
```

## Minimum config

Add this to `~/.pi/agent/magpie.json` or `.pi/magpie.json`:

```json
{
  "subagents": {
    "memory": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "low",
      "prompt": {
        "strategy": "append",
        "file": ".pi/prompts/memory.md"
      }
    }
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
  "telegram": {
    "hostUrl": "http://127.0.0.1:8787",
    "models": {
      "sonnet": "anthropic/claude-sonnet-4-6"
    }
  },
  "webui": {
    "enabled": true
  }
}
```

Notes:
- `subagents.memory` stays under top-level `subagents`, not under `memory`
- `webui.enabled: true` is needed because Telegram and `dream` talk to the assistant host over HTTP
- `memory.autodream.schedule` is a normal cron expression

## Minimum auth for Telegram testing

Add this to `~/.pi/agent/magpie.auth.json` or `.pi/magpie.auth.json`:

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

If you want Telegram notifications from scheduled tasks, also set this in `magpie.json`:

```json
{
  "schedule": {
    "notifier": "telegram",
    "telegram": {
      "chatId": "123456789"
    }
  }
}
```

If you do **not** set `schedule.telegram.chatId`, autodream can still be scheduled.
It will fall back to the scheduler's normal notifier behavior.

## Start the required processes

### 1. Install/build Magpie in pi

From this repo:

```bash
pi install ./
```

### 2. Start the web/assistant host

Open pi in this repo or any repo using this config:

```bash
pi
```

Because `webui.enabled` is true, session start should bring up the assistant host.

### 3. Start the Telegram bot

From this repo:

```bash
bun run apps/telegram/src/index.ts
```

You should see:

```text
Starting Magpie-backed Telegram bot...
```

## Quick local checks

Inside pi:

### Save a preference

Ask the assistant something like:
- "remember that I prefer short commit messages"

Or explicitly trigger the tool behavior with a request that should cause `save_preference`.

### Capture memory

Ask:
- "remember that X sent a Y update"

Then inspect:
- `read_memory` with `path: "inbox"`

Or from the shell:

```bash
ls ~/.pi/agent/magpie-memory/inbox
```

### Recall memory

Ask:
- "what do you remember about X and Y?"

That should use `recall_memory`, which now searches the memory root itself with file tools and then references the relevant files it found.

## Manual Telegram dream test

This is the most important test right now.

### 1. Create some Telegram conversation state

In Telegram, message your bot with a few things worth remembering, for example:
- "X emailed me about Y again"
- "I need to reply tomorrow"
- "School paperwork is still pending"

Optionally ask the assistant to remember some of that explicitly during the conversation.

### 2. Trigger dream

In Telegram, say something like:
- "dream for a moment"
- "go dream"
- "dream and organize this"

### 3. Expected result

`dream` should:
- read the active Telegram thread
- read inbox files
- write/update files under the memory root
- create:
  - `archive/telegram/...`
  - `archive/dreams/...`
  - `digest/daily/YYYY-MM-DD.md`
  - optionally `review/YYYY-MM-DD.md`
  - graph files under `graph/`
- queue a Telegram thread reset after returning

### 4. Inspect outputs

```bash
find ~/.pi/agent/magpie-memory -maxdepth 3 | sort
```

Good places to inspect first:

```bash
ls ~/.pi/agent/magpie-memory/archive/telegram
ls ~/.pi/agent/magpie-memory/archive/dreams
ls ~/.pi/agent/magpie-memory/digest/daily
ls ~/.pi/agent/magpie-memory/review
find ~/.pi/agent/magpie-memory/graph -type f | sort
```

## Nightly autodream test

Autodream is maintained through the schedule system.

### 1. Confirm the schedule exists

Inside pi:

```text
/schedule list
```

You should see a recurring entry whose task contains:

```text
[magpie:autodream] Run nightly autodream now.
```

### 2. Use a temporary fast schedule for testing

Instead of waiting until 04:00, temporarily change config to something like:

```json
{
  "memory": {
    "autodream": {
      "enabled": true,
      "schedule": "*/5 * * * *"
    }
  }
}
```

Then start a new pi session or reload the extension environment so the schedule is reconciled.

After testing, change it back.

### 3. Check scheduler output

Inside pi:

```text
/schedule list
/schedule logs <id>
```

The scheduled run writes result output into the schedule store and uses a background session dir.

## Troubleshooting

### `dream currently only supports Telegram assistant threads`
You triggered `dream` from a non-Telegram context without an active Telegram thread to target.
Create/use a Telegram thread first.

### `Failed to load Telegram thread snapshot`
The web/assistant host is probably not running, or `telegram.hostUrl` is wrong.
Check:
- pi is running with `webui.enabled: true`
- `telegram.hostUrl` matches the host process

### No autodream schedule appears
Check:
- `memory.autodream.enabled` is `true`
- `memory.autodream.schedule` is valid cron
- a pi session actually started after config was loaded
- `/schedule list`

### Autodream runs but no Telegram notification arrives
That is notifier configuration, not memory itself.
Set either:
- `schedule.notifier: "telegram"` + `schedule.telegram.chatId`
- or use macOS notifications

### Memory graph gets unrelated context on dream
That should now be fixed for empty transcript/no-note runs. If it still happens, inspect:
- `archive/telegram/...`
- `archive/dreams/...`
- the generated digest/review files

## Good first test sequence

1. start pi with `webui.enabled: true`
2. start the Telegram bot
3. send a few meaningful Telegram messages
4. trigger manual `dream`
5. inspect `~/.pi/agent/magpie-memory/`
6. set autodream schedule to `*/5 * * * *`
7. confirm `/schedule list`
8. wait for one run
9. inspect `/schedule logs <id>`
10. restore the schedule to `0 4 * * *`
