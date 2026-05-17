# handoff

`/handoff <goal>` generates a focused prompt for continuing work in a new session.

```text
/handoff continue the config rewrite
/handoff -mode plan make an implementation plan for the sessions work
```

Handoff supports `default` and `plan` modes. Plan mode is activated with `/mode plan` in the new session when needed.

If no explicit model is provided, Magpie uses `config.handoff.model`; if absent, it inherits the current session model.
