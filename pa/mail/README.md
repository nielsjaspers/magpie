# PA Mail

Mail integration for personal-assistant mode.

## Current capabilities

Implemented right now:

- search the Gmail aggregation inbox
- list unread messages
- fetch full message bodies
- fetch thread summaries
- summarize recent conversation history with a person
- gather draft context for a reply
- save drafts locally

Read-only by design:

- no send
- no archive/delete
- no label modification
- no provider-side draft saving

## Architecture

PA mail talks to one Gmail inbox only.

That Gmail inbox is expected to act as an aggregation point for forwarded mail from:

- school mail
- Proton mail
- other sources you choose to forward

This keeps the implementation simple and preserves the read-only model.

## Auth

Secrets live in `magpie.auth.json`:

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

Use a Gmail app password, not your normal password.

## Step-by-step setup

## 1. Choose the Gmail aggregation inbox

Use either:

- a burner Gmail account
- an older unused Gmail account
- or another dedicated Gmail inbox

This inbox is the only mailbox Magpie reads directly.

## 2. Enable 2FA and generate an app password

On the Gmail account:

- enable two-factor authentication
- generate an app password
- place that app password in `magpie.auth.json`

## 3. Forward upstream mail into Gmail

Configure your other providers to auto-forward into the Gmail inbox.

Examples:

- school Outlook → Gmail
- Proton → Gmail

V1 assumes this forwarding-based architecture.

## 4. Optionally add Gmail labels/filters

Recommended labels:

- `source/school`
- `source/proton`
- `source/gmail`

These are optional, but strongly recommended.

Suggested Gmail filters:

- label by original recipient/source
- mark important sources consistently
- optionally never send some forwarded sources to spam

## 5. Test search and unread flows

Ask:

- "any unread mail"
- "any new mail from my supervisor"
- "search my mail for internship"
- "show me unread school mail"

Expected behavior:

- results are concise
- bodies are not dumped unless explicitly fetched
- labels can be used when present

## 6. Fetch a full message

Ask:

- "show me the full text of that email"

Expected behavior:

- Magpie fetches the selected message body
- text/plain is preferred
- html is converted to text if needed
- obvious quoted text is reduced where possible

## 7. Draft and save a reply

Ask:

- "help me draft a reply to this"
- "save that draft"

Expected behavior:

- Magpie gathers context with `email_draft_context`
- writes the draft in chat
- saves it via explicit `email_save_draft`

## Storage

Mail persistence lives under:

```text
<storageDir>/mail/
  contacts/
    <contact-name>/
      drafts/
      PREFERENCES.md
      history/
      NOTES.md
  history/
```

Current implementation definitely writes:

- history draft files under `mail/history/`
- optional contact-scoped draft files under `mail/contacts/<contact>/drafts/`

The rest of the structure is reserved for future contact intelligence.

## Tool surface

Current tools:

- `email_search`
- `email_list_unread`
- `email_fetch`
- `email_threads`
- `email_conversation_history`
- `email_draft_context`
- `email_save_draft`

## Notes and caveats

- only one Gmail inbox is read directly
- forwarding captures whatever reaches that Gmail inbox, not magically every historical message from every provider
- forwarded messages can land in spam, so watch that during setup
- labels are optional but useful
- no send capability exists in v1

## Post-v1 direction

Likely future directions:

- richer contact history folders
- `PREFERENCES.md` generation per contact
- PA-specific query subagents for mail retrieval
- better quote stripping and body cleanup
