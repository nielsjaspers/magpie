# magpie

Magpie is a [pi](https://pi.dev) package that adds modes, subagents, planning, memory, session intelligence, a research companion, personal-assistant integrations, web utilities, and remote session dispatch.

<img
  src="./magpie.webp"
  alt="Close-up of a Black-billed Magpie on a Tree"
  title="Photo by Bejan Adrian: https://www.pexels.com/photo/close-up-of-a-black-billed-magpie-on-a-tree-36937253/"
  width="384"
/>

## Install

```bash
pi install ./
```

Or from git:

```bash
pi install git:github.com/nielsjaspers/magpie
```

## Configuration

Magpie reads JSON config from two scopes. Project config overrides global config.

**Settings** (`magpie.json`):

- Global: `~/.pi/agent/magpie.json`
- Project: `.pi/magpie.json`

**Secrets** (`magpie.auth.json`):

- Global: `~/.pi/agent/magpie.auth.json`
- Project: `.pi/magpie.auth.json`

Copy the examples as a starting point:

```bash
cp magpie.example.json ~/.pi/agent/magpie.json
cp magpie.auth.example.json ~/.pi/agent/magpie.auth.json
```

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full `magpie.json` reference and [`docs/AUTH.md`](docs/AUTH.md) for `magpie.auth.json`.

### Minimal config

```json
{
  "modes": {
    "smart": {
      "model": "opencode-go/mimo-v2-pro",
      "thinkingLevel": "high"
    }
  },
  "subagents": {
    "default": "opencode-go/minimax-m2.7"
  }
}
```

Magpie supplies defaults for everything else. The built-in modes are `smart`, `rush`, `deep`, and `learn`.

## Commands and tools

| Extension | What it adds |
|-----------|--------------|
| `modes` | `/mode`, `/magpie-config`, `/magpie-reload` — switch agent modes, edit config, reload on the fly |
| `subagents` | `search_subagent`, `oracle_subagent`, `librarian_subagent` — spawn read-only subagents for retrieval, reasoning, and research |
| `plan` | `/plan`, `/plan-file`, `/todos`, `plan_subagent`, `user_question`, `plan_exit` — strict planning loop with research, questionnaire, and execution phases (`Ctrl+Alt+P` toggles plan mode) |
| `btw` | `/btw` — background task worker (see [`btw/README.md`](btw/README.md)) |
| `commit` | `/commit` — background git commit drafting (see [`commit/README.md`](commit/README.md)) |
| `handoff` | `/handoff`, `handoff` tool — start a new session with transferred context (see [`handoff/README.md`](handoff/README.md)) |
| `sessions` | `/sessions`, `get_sessions`, `session_query` — index and search past sessions (see [`sessions/README.md`](sessions/README.md)) |
| `preferences` | `/save-preference`, `/forget-preference`, `/preferences`, `save_preference`, `recall_preferences` — small durable JSONL store for conventions and facts |
| `memory` | `/remember`, `remember`, `read_memory`, `write_memory`, `recall_memory`, `dream` — inbox/graph/archive/digest/review memory system (see [`memory/README.md`](memory/README.md)) |
| `research` | `/papers`, `/digest` — Semantic Scholar search and Socratic reading (see [`research/README.md`](research/README.md)) |
| `web` | `web_fetch`, `web_search` — fetch pages as markdown and search the web via OpenCode |
| `schedule` | `/schedule`, `schedule` tool — one-shot and recurring background tasks with notifications |
| `remote` | `/remote`, `remote_send`, `remote_status` — dispatch and fetch sessions on a remote host |
| `webui` | Local HTTP server and browser UI surface for assistant sessions |
| `spinner` | Random verb spinner while streaming (see [`spinner/README.md`](spinner/README.md)) |
| `pa/calendar` | Calendar read/write via iCloud CalDAV and ICS feeds (see [`pa/calendar/README.md`](pa/calendar/README.md)) |
| `pa/mail` | `/pa-mail-debug`, Gmail aggregation inbox read and draft persistence (see [`pa/mail/README.md`](pa/mail/README.md)) |
| `apps/telegram` | Separate Telegram bot process that forwards slash commands to Magpie (see [`apps/telegram/README.md`](apps/telegram/README.md)) |

## File layout

```
.
├── package.json              # pi package manifest; extensions listed under "pi.extensions"
├── magpie.example.json       # full example config
├── magpie.auth.example.json  # full example auth
├── config/                   # config loader, defaults, and types
├── subagents/                # shared subagent core used by plan, handoff, btw, commit, etc.
├── modes/                    # mode switching and prompt injection
├── plan/                     # planning loop tools and questionnaire
├── btw/                      # background task worker
├── commit/                   # background git commit helper
├── handoff/                  # session handoff command + tool
├── sessions/                 # session indexing and query
├── preferences/              # JSONL preference store
├── memory/                   # memory system scaffolding
├── research/                 /papers and /digest
├── web/                      # web_fetch and web_search
├── schedule/                 # background scheduling with at/cron
├── remote/                   # remote session dispatch/fetch
├── webui/                    # HTTP server + browser UI
├── spinner/                  # streaming spinner
├── pa/                       # personal-assistant calendar + mail
└── apps/telegram/            # standalone Telegram bot
```
