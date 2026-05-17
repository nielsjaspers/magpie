# Magpie auth configuration

Auth config is read from:

- global: `$PI_CODING_AGENT_DIR/magpie.auth.json` or `~/.pi/agent/magpie.auth.json`
- project: `<cwd>/.pi/magpie.auth.json`

Project auth is deep-merged over global auth.

## Personal assistant

```json
{
  "personalAssistant": {
    "calendar": {
      "icloud": {
        "email": "you@example.com",
        "appPassword": "app-specific-password"
      },
      "icsFeeds": [
        { "id": "school", "name": "School", "url": "webcal://example.edu/calendar.ics" }
      ]
    },
    "mail": {
      "gmail": {
        "address": "you@gmail.com",
        "appPassword": "app-specific-password"
      }
    }
  }
}
```

## Telegram / schedule notifications

```json
{
  "telegram": {
    "botToken": "..."
  }
}
```

## Remote

Remote device tokens may be stored under `remote.hosts.<name>.deviceToken`.
