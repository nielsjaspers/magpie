# Personal Assistant

Personal-assistant extensions for Magpie.

This area contains the PA-mode calendar and mail integrations.
These extensions always register, but are intended to be used through a normal Magpie mode such as `pa` with `disableTools` configured appropriately.

## What exists right now

Current PA functionality:

- calendar read from one or more ICS feeds
- calendar read from iCloud via CalDAV
- calendar event creation in iCloud
- mail read from one Gmail aggregation inbox via IMAP
- local mail draft persistence

Not in v1:

- calendar deletion
- calendar editing
- recurring event authoring
- reminders/alarms
- sending email
- email archive/delete/label mutation
- direct Outlook API integration
- Proton Bridge integration
- direct iCloud mail integration

## Directory layout

```text
pa/
  README.md
  shared/
    config.ts
    mode.ts
    storage.ts
    types.ts
  calendar/
    index.ts
    README.md
  mail/
    index.ts
    README.md
```

## Step-by-step setup

## 1. Add a PA mode to your Magpie config

File:
- `~/.pi/agent/magpie.json`
- or `.pi/magpie.json`

Example:

```json
{
  "startupMode": "smart",
  "modes": {
    "pa": {
      "statusLabel": "pa",
      "thinkingLevel": "high",
      "disableTools": [
        "handoff",
        "commit",
        "plan_subagent",
        "user_question",
        "plan_exit",
        "search_subagent",
        "oracle_subagent",
        "librarian_subagent"
      ]
    }
  },
  "personalAssistant": {
    "timezone": "Europe/Amsterdam",
    "storageDir": "~/.pi/agent/personal-assistant",
    "calendar": {
      "defaultWritableCalendar": "personal"
    }
  }
}
```

Notes:

- `startupMode` can be `"pa"` on your VPS if you want it to boot directly into PA mode.
- `disableTools` is user-controlled. PA mode does not automatically disable all file/web tools.
- `personalAssistant.storageDir` is where draft files and calendar cache files are stored.

## 2. Add PA credentials to auth config

File:
- `~/.pi/agent/magpie.auth.json`
- or `.pi/magpie.auth.json`

Example:

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
    },
    "mail": {
      "gmail": {
        "address": "magpie-inbox@gmail.com",
        "appPassword": "xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Notes:

- `webcal://` feed URLs are supported. Runtime normalizes them to `https://`.
- secrets belong in `magpie.auth.json`, not in `magpie.json`.
- project auth overrides global auth.

## 3. Switch into PA mode

From inside Magpie:

```text
/mode pa
```

If your VPS config sets:

```json
{ "startupMode": "pa" }
```

then PA mode becomes the default startup mode there.

## 4. Verify tools are available

Ask natural questions such as:

- "what's on my calendar this week"
- "anything on friday morning"
- "any unread school mail"
- "show me the full text of that email"
- "help me draft a reply"

The PA integrations are tool-driven rather than command-driven.

## 5. Check local persistence

PA data is written under:

```text
<personalAssistant.storageDir>/
```

Current layout:

```text
<storageDir>/
  calendar/
    cache/
    logs/
  mail/
    contacts/
      <contact-name>/
        drafts/
        PREFERENCES.md
        history/
        NOTES.md
    history/
```

Current implementation definitely writes:

- calendar ICS cache JSON files under `calendar/cache/`
- mail draft files under `mail/history/`
- optional contact-scoped draft copies under `mail/contacts/<contact>/drafts/`

The rest of the structure is reserved for future evolution.

## Operational notes

### Calendar

- school/subscription calendars should be configured as direct ICS feed URLs
- iCloud calendars use CalDAV and an Apple app-specific password
- subscribed `webcal://` feeds are read-only
- iCloud is the writable calendar path

### Mail

- Magpie reads one Gmail inbox only
- other mail sources are expected to forward into that Gmail inbox
- labels are optional but recommended
- no mail sending tools exist

## Recommended Gmail setup

Use a dedicated or low-traffic Gmail inbox as the aggregation point.

Recommended filter labels:

- `source/school`
- `source/proton`
- `source/gmail`

The mail tools work without labels, but labels make filtering much more useful.

## Recommended iCloud setup

Generate an app-specific password for the Apple ID used for calendar access.

Use that in:

```json
personalAssistant.calendar.icloud.appPassword
```

Do not use your primary Apple password.

## Related docs

- `pa/calendar/README.md`
- `pa/mail/README.md`
