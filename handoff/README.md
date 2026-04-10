# handoff

A Pi extension that adds a `/handoff` command to transfer context to a new focused session.

## How it works

Instead of compacting (which is lossy), handoff uses an LLM to extract what
matters for your next task and creates a new session with a generated prompt.

When you run `/handoff <goal>`, it:

1. Collects your current conversation history
2. Uses an LLM to generate a focused, self-contained prompt summarizing:
   - Relevant context and decisions
   - Key files discussed or modified
   - The next task based on your goal
3. Opens the generated prompt in an editor for review/editing
4. Creates a new session linked to the current one
5. Places the prompt in your editor ready for submission

## Usage

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

## Why use it

- **Compacting is lossy** — it can discard context you'll need later
- **Handoff is targeted** — it extracts only what's relevant to your *next* task
- **You can edit the prompt** before it's sent, giving you control
- **Session linking** — the new session knows it came from the old one, maintaining traceability

## Requirements

- Pi extension system
- A model selected in Pi (used for generating the handoff prompt)

## Installation

```bash
# Global
cp -r "$(pwd)/handoff" ~/.pi/agent/extensions/handoff.ts

# Project-local
mkdir -p .pi/extensions
cp -r "$(pwd)/handoff" .pi/extensions/handoff.ts
```

Then reload Pi (`/reload`) or restart.
