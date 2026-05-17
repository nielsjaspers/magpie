# magpie-v2

Magpie is a [pi](https://pi.dev) package for a focused coding workflow: skill-backed modes, delegation, structured user questions, handoff, session search, web utilities, background tasks, commits, memory, scheduling, remote/web UI helpers, and optional personal-assistant tools.

## Install

From this directory:

```bash
pi install ./
```

## Quick config

Magpie config lives at:

- global: `~/.pi/agent/magpie.json`
- project: `.pi/magpie.json`

Copy this as a simple starting point:

```json
{
  "modes": {
    "plan": {
      "statusLabel": "plan",
      "skills": ["planning"]
    },
    "pa": {
      "statusLabel": "pa",
      "tools": [
        "calendar_upcoming",
        "calendar_get_event",
        "calendar_create_event",
        "email_search",
        "email_list_unread",
        "email_fetch",
        "email_save_draft"
      ],
      "hideTools": ["edit", "write"]
    }
  },
  "delegate": {
    "model": "provider/model-id",
    "thinkingLevel": "medium"
  },
  "handoff": {
    "defaultMode": "default"
  },
  "sessions": {
    "autoIndex": true,
    "maxIndexEntries": 500
  },
  "web": {
    "searchTimeout": 120000,
    "fetchTimeout": 30000
  }
}
```

If you do not set worker models, Magpie uses the current session model.

## Core commands and tools

| Area | Adds |
|---|---|
| Modes | `/mode`, `/magpie-config`, `/magpie-reload` |
| Delegate | `delegate` tool with optional model/thinking override |
| Questions | `ask_user` structured questionnaire tool |
| Handoff | `/handoff`, `handoff`, `/handoff-continue` |
| Sessions | `/sessions`, `get_sessions`, `session_query` |
| Web | `web_fetch`, `web_search` |
| Background | `/btw`, `/commit`, `/schedule` |
| Memory | `/remember`, `remember`, `read_memory`, `write_memory`, `recall_memory`, `dream` |
| Preferences | `/save-preference`, `/forget-preference`, `/preferences`, `save_preference`, `recall_preferences` |
| Remote/web UI | `/remote`, `remote_send`, `remote_status`, optional browser UI |
| Personal assistant | calendar and email tools, usually exposed through a custom mode |

## Modes

`default` is implicit. Named modes are just skill/tool bundles. There are no built-in smart/rush/deep/learn modes.

Planning is now `/mode plan`, backed by `skills/planning/SKILL.md`; there is no separate old plan runtime.

## More docs

- [Configuration](docs/CONFIGURATION.md)
- [Auth/secrets](docs/AUTH.md)
- [Handoff](handoff/README.md)
- [Sessions](sessions/README.md)
- [Memory](memory/README.md)
- [Personal assistant](pa/README.md)
- [Telegram app](apps/telegram/README.md)

Research/digest is intentionally not included in this rewrite; it will return later as a custom personal mode.
