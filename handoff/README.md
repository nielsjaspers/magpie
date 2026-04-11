# handoff

A Pi extension that transfers context to a new focused session.

It supports:
- `/handoff` command (manual, editable prompt)
- `handoff` tool (agent-callable, automatic session continuation)

> Tool-path session switching is inspired by `pi-amplike` (credited).

## How it works

Handoff uses an LLM to extract relevant context for the next task.

### `/handoff` command path
1. Collect conversation history
2. Generate handoff prompt
3. Open editor for review/edit
4. Create new session
5. Put prompt in editor for manual submit

### `handoff` tool path
1. Collect conversation history
2. Generate handoff prompt
3. Open editor so you can adjust the prompt
4. Defer session switch until `agent_end`
5. Start a new session automatically
6. Continue automatically in the new thread

## Usage

### Manual command

```bash
/handoff now implement this for teams as well
/handoff -mode plan make a plan for feature flags rollout
/handoff -model github-copilot/gemini-3-flash-preview check other places that need this fix
```

Flags:
- `-mode <plan|default>`
- `-model <provider/model-id>`

### Conversational trigger (tool)

Examples:
- `Handoff and build an admin panel for this`
- `Handoff and check if this issue exists elsewhere`
- `Handoff and make a plan for X`

For tool calls, mode can be inferred automatically from wording like “make a plan …” (prefers `plan`).

## Config

Config files:
- Project: `.pi/handoff.json`
- Global: `~/.pi/agent/handoff.json` (or `${PI_CODING_AGENT_DIR}/handoff.json`)

Schema:

```json
{
  "model": "provider/model-id",
  "modeModels": {
    "default": "provider/model-id",
    "plan": "provider/model-id"
  }
}
```

Precedence:
1. Project config
2. Global config
3. Current active model

If configured models are invalid/unavailable, handoff silently falls back to the current active model.

## Plan-mode integration

When effective handoff mode is `plan`, handoff emits `magpie:handoff:set-mode`.

`plan-mode` listens to this and toggles itself on/off accordingly:
- `plan` => enables plan mode
- `default` => disables plan mode

## Requirements

- Interactive UI mode
- At least one usable model with auth

## Installation

```bash
# Global
cp -r "$(pwd)/handoff" ~/.pi/agent/extensions/handoff.ts

# Project-local
mkdir -p .pi/extensions
cp -r "$(pwd)/handoff" .pi/extensions/handoff.ts
```

Reload Pi (`/reload`) or restart.
