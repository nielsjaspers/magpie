# /commit

`/commit` runs as a background subagent, similar to `/btw`.

Behavior:
- uses the current branch conversation as supporting context
- filters its own custom result messages out of the main agent context
- inspects recent git commit style in the repo
- inspects current staged/recent changes
- creates a git commit directly

Usage:

```text
/commit
/commit -model github-copilot/gpt-5-mini
/commit tighten message around session indexing changes
```

Configuration:

```json
{
  "subagents": {
    "commit": { "model": "github-copilot/gpt-5-mini", "thinkingLevel": "low" }
  }
}
```

If no explicit `-model` is provided, magpie resolves the model from `subagents.commit`, then `subagents.default`.
