# Handoff

Handoff for magpie.

It supports:
- `/handoff` command
- `handoff` tool

## How it works

Handoff uses the shared magpie subagent core with role `handoff`.

### Command path
1. Collect conversation history
2. Generate a handoff prompt
3. Add parent-session metadata when available
4. Open editor for review/edit
5. Create a new session
6. Put the prompt in the editor for manual submit

### Tool path
1. Collect conversation history
2. Generate a handoff prompt
3. Add parent-session metadata when available
4. Open editor for review/edit
5. Defer session switch until `agent_end`
6. Start a new session automatically
7. Continue automatically in the new thread

## Usage

```bash
/handoff now implement this for teams as well
/handoff -mode plan make a plan for feature flags rollout
/handoff -model github-copilot/gpt-5-mini check other places that need this fix
```

## Config

Handoff reads the shared magpie config:

- Global: `~/.pi/agent/magpie.json`
- Project: `.pi/magpie.json`

Relevant field:

```json
{
  "subagents": {
    "handoff": "opencode-go/mimo-v2-pro"
  }
}
```

If `subagents.handoff` is not set, handoff falls back to `subagents.default`, then to the current session model.
