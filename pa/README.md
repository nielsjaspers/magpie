# Personal assistant tools

Magpie includes optional calendar and mail tools. They always register, but the default mode/tool resolver hides optional PA tools unless you expose them with a mode.

Example mode:

```json
{
  "modes": {
    "pa": {
      "statusLabel": "pa",
      "tools": [
        "calendar_list_calendars",
        "calendar_upcoming",
        "calendar_get_event",
        "calendar_create_event",
        "email_search",
        "email_list_unread",
        "email_fetch",
        "email_threads",
        "email_conversation_history",
        "email_draft_context",
        "email_save_draft"
      ],
      "hideTools": ["edit", "write"]
    }
  },
  "personalAssistant": {
    "timezone": "Europe/Amsterdam",
    "storageDir": "~/.pi/agent/personal-assistant"
  }
}
```

Activate with:

```text
/mode pa
```

Credentials live in `magpie.auth.json` under `personalAssistant`.
