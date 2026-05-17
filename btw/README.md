# btw

`/btw <prompt>` runs a one-off background subagent with the current conversation as context.

```text
/btw summarize the current diff
/btw -model provider/model-id inspect this refactor for edge cases
```

If no `-model` is provided, Magpie uses `config.btw.model`; if absent, it inherits the current session model.
