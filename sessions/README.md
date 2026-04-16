# Sessions

Session indexing and query tools for magpie.

It supports:
- `get_sessions` tool
- `session_query` tool
- `/sessions` command
- `/session` command

## Recommended workflow

Use the session tools in two steps:

1. Call `get_sessions` to discover candidate sessions.
2. Pick a `sessionPath` from the results.
3. Call `session_query` with that exact path for deeper inspection.

## Tools

### `get_sessions`

Lists indexed sessions with:
- `sessionPath`
- `startedAt`
- `endedAt`
- `summary`
- `topics`
- `filesModified`
- `cwd`
- `messageCount`

Parameters:
- `query` — fuzzy keyword matching over summaries, topics, and modified files
- `from` — inclusive time window start
- `to` — inclusive time window end
- `sort` — `newest` (default), `oldest`, or `best_match`
- `limit` — defaults to `10`, max `50`

#### Date filtering

Date filters use overlap semantics. A session is included when its time range overlaps the requested window:

- `startedAt <= to`
- `endedAt >= from`

This makes requests like these work well once the agent converts them into explicit timestamps:

- “all sessions from yesterday”
- “all sessions between April 1st and 4th”
- “sessions about auth from last week”

For whole-day requests, prefer full-day boundaries such as `00:00:00.000` through `23:59:59.999` in the local timezone.

### `session_query`

Queries a specific session for context, decisions, file changes, and implementation details.

Use `get_sessions` first when you do not already know the correct `sessionPath`.

If `sessionPath` is omitted, `session_query` will first try to use `**Parent session:**` metadata from the current thread before searching indexed sessions.

## Commands

Available commands:
- `/sessions`
- `/sessions search <query>`
- `/sessions pending`
- `/sessions sync`
- `/sessions reindex <path>`
- `/sessions reindex-all`

Singular aliases are also supported:
- `/session`
- `/session search <query>`
- `/session pending`
- `/session sync`
- `/session reindex <path>`
- `/session reindex-all`

Command behavior:
- `sync` indexes discovered session files that are not yet indexed and skips already indexed sessions
- `reindex-all` rebuilds index entries for all discovered session files
