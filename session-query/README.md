# session-query

Query previous Pi session files for historical context (decisions, file changes, rationale, unresolved issues).

> Adapted from `pi-amplike/extensions/session-query.ts`.

## Tool

- `session_query`

Parameters:
- `question` (required)
- `sessionPath` (optional if current thread contains `**Parent session:** ...` from handoff)

## Handoff integration

This extension is designed to pair with `handoff/`.

Handoff now includes parent-session metadata in generated handoff prompts:

```md
**Parent session:** `/absolute/path/to/session.jsonl`
```

In a handed-off session, the model can call `session_query` without `sessionPath` and it will auto-detect that parent session path.

## Examples

```text
session_query({
  question: "What files were modified and why?"
})

session_query({
  sessionPath: "/Users/me/.pi/agent/sessions/abc/session.jsonl",
  question: "What approach did we reject for auth and why?"
})
```

## Installation

```bash
# Global
cp -r "$(pwd)/session-query" ~/.pi/agent/extensions/session-query.ts

# Project-local
mkdir -p .pi/extensions
cp -r "$(pwd)/session-query" .pi/extensions/session-query.ts
```

Reload Pi (`/reload`) or restart.
