# PA Calendar

Calendar integration for personal-assistant mode.

## Current capabilities

Implemented right now:

- list configured calendar sources
- read upcoming events from ICS feeds
- read upcoming events from iCloud calendars
- merge ICS + iCloud results
- fetch a full event by id
- create events in iCloud

Not in v1:

- delete events
- update existing events
- recurring event creation
- attendee invites
- alarms/reminders

## Config

Non-secret config lives in `magpie.json`:

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

Notes:

- `defaultWritableCalendar` is matched against iCloud calendar name or id.
- `storageDir` is used for ICS cache persistence.

## Auth

Secrets live in `magpie.auth.json`:

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

## Step-by-step setup

## 1. Add your ICS feeds

Under:

```json
personalAssistant.calendar.icsFeeds
```

Each entry supports:

- `id`
- `name`
- `url`

Example:

```json
{
  "id": "school",
  "name": "[School name]",
  "url": "webcal://..."
}
```

Important:
- `webcal://` is fine
- runtime converts it to `https://`
- these feeds are always read-only

## 2. Add iCloud credentials

Under:

```json
personalAssistant.calendar.icloud
```

Use:

- Apple ID email
- Apple app-specific password

Do not use your normal Apple password.

## 3. Set a default writable calendar

In `magpie.json`:

```json
{
  "personalAssistant": {
    "calendar": {
      "defaultWritableCalendar": "personal"
    }
  }
}
```

This should match your intended writable iCloud calendar name or id.

## 4. Test listing calendars

Ask:

- "list my calendars"
- "what calendar sources do you have"

Expected result:

- ICS feed sources are listed as read-only
- iCloud calendars are listed as writable if credentials work

## 5. Test reads

Ask:

- "what's on my calendar this week"
- "anything friday morning"
- "show me school events in the next 14 days"

Expected behavior:

- ICS + iCloud results are merged
- recurring ICS events are expanded into concrete instances
- failures from one source should not completely hide the others

## 6. Test event creation

Ask:

- "schedule lunch with X friday at 12:30 for one hour"

Expected behavior:

- Magpie creates the event in your configured iCloud calendar
- the created event should appear in Apple Calendar shortly after

## Storage

Calendar persistence currently includes:

```text
<storageDir>/calendar/cache/
```

This stores cached ICS feed results.

## Tool surface

Current tools:

- `calendar_list_calendars`
- `calendar_upcoming`
- `calendar_get_event`
- `calendar_create_event`

## Notes and caveats

- ICS feeds are read-only
- iCloud is currently the only write target
- subscribed calendars are not discovered from iCloud automatically; configure them directly as ICS feeds
- iCloud auth failures are returned as tool errors rather than crashing startup

## Post-v1 direction

Planned early follow-up:

- `calendar_delete_event`

Later:

- event editing
- recurring event authoring
- reminders
