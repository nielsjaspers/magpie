# Memory

Memory is optional. It provides tools for capturing, reading, writing, recalling, and consolidating memory files.

Configuration:

```json
{
  "memory": {
    "rootDir": "~/.pi/agent/memory",
    "model": {
      "model": "provider/model-id",
      "thinkingLevel": "medium"
    },
    "autodream": {
      "enabled": false,
      "schedule": "0 3 * * *"
    }
  }
}
```

Tools:

- `remember`
- `read_memory`
- `write_memory`
- `recall_memory`
- `dream`
- `memory_subagent` (internal dream phase worker)

These tools are hidden by default unless exposed by a mode or feature flow. Memory worker model config is `memory.model`; if absent, it inherits the current session model.
