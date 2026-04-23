# Auth

Secrets live in `magpie.auth.json` so they do not leak into version-controlled `magpie.json` files.

Scopes work the same as config:

- **Global:** `~/.pi/agent/magpie.auth.json`
- **Project:** `.pi/magpie.auth.json`

Project auth overrides global auth. Deep-merge rules apply.

## Reference

### `semanticScholar`

Used by `/papers` for Semantic Scholar API requests.

```json
{
  "semanticScholar": {
    "apiKey": "your-semantic-scholar-api-key"
  }
}
```

### `exa`

Reserved for future integrations.

```json
{
  "exa": {
    "apiKey": "your-exa-api-key"
  }
}
```

### `personalAssistant.calendar`

Calendar credentials for PA mode.

```json
{
  "personalAssistant": {
    "calendar": {
      "icloud": {
        "email": "user@icloud.com",
        "appPassword": "xxxx-xxxx-xxxx-xxxx"
      },
      "icsFeeds": [
        {
          "id": "school",
          "name": "School",
          "url": "webcal://example.edu/calendar.ics"
        }
      ]
    }
  }
}
```

- `icloud.email` — Apple ID email
- `icloud.appPassword` — Apple app-specific password (not your primary Apple password)
- `icsFeeds` — read-only ICS feed list; `webcal://` is normalized to `https://` at runtime

### `personalAssistant.mail`

Mail credentials for PA mode.

```json
{
  "personalAssistant": {
    "mail": {
      "gmail": {
        "address": "magpie-inbox@gmail.com",
        "appPassword": "xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- `gmail.address` — Gmail aggregation inbox address
- `gmail.appPassword` — Gmail app password (not your primary Gmail password)

### `telegram`

Telegram bot token. Used by `apps/telegram` and schedule notifications.

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

`schedule.telegram.botToken` in `magpie.json` is also supported, but `telegram.botToken` in `magpie.auth.json` is the preferred location.
