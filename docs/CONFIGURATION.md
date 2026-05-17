# Magpie configuration

Magpie reads configuration from:

1. global: `$PI_CODING_AGENT_DIR/magpie.json` or `~/.pi/agent/magpie.json`
2. project: `<cwd>/.pi/magpie.json`

Project config is deep-merged over global config, which is deep-merged over the small built-in default config. There are no legacy migrations in this rewrite.

## Defaults

```json
{
  "modes": {
    "plan": {
      "statusLabel": "plan",
      "skills": ["planning"]
    }
  },
  "handoff": { "defaultMode": "default" },
  "sessions": { "autoIndex": true, "maxIndexEntries": 500 },
  "web": { "searchTimeout": 120000, "fetchTimeout": 30000 }
}
```

Absent worker model fields inherit the current session model.

## Modes

`default` is implicit and is not a configured mode. Named modes are skill/tool bundles:

```json
{
  "modes": {
    "pa": {
      "statusLabel": "pa",
      "skills": ["personal-assistant"],
      "tools": ["calendar_upcoming", "email_search"],
      "hideTools": ["edit", "write"]
    }
  }
}
```

Mode fields:

- `skills`: skill names to inject while the mode is active.
- `tools`: extra tools to expose in that mode.
- `hideTools`: tools to hide in that mode.
- `statusLabel`: footer label. If omitted, the mode name may be shown.

Use `/mode`, `/mode default`, or `/mode <name>`.

## Worker model config

Worker model references can be either a string or an object:

```json
{
  "delegate": "provider/model-id",
  "commit": {
    "model": {
      "model": "provider/model-id",
      "thinkingLevel": "low"
    }
  }
}
```

Supported worker sections:

- `delegate`
- `handoff.model`
- `sessions.model`
- `commit.model`
- `btw.model`
- `memory.model`
- `schedule.model`

## Features

Optional feature sections are present only when you use them:

- `preferences`
- `memory`
- `personalAssistant`
- `telegram`
- `remote`
- `webui`
- `schedule`

Research/digest is intentionally not part of this rewrite package.

## Web

```json
{
  "web": {
    "searchModel": "provider/model-id",
    "searchTimeout": 120000,
    "fetchTimeout": 30000
  }
}
```

`web_search` uses OpenCode. If `searchModel` is omitted, it uses the current session model.
