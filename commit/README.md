# commit

`/commit` asks a commit worker to inspect the repository state, infer the local commit style, and create one coherent git commit when appropriate.

```text
/commit
/commit -model provider/model-id
```

If no explicit model is provided, Magpie uses `config.commit.model`; if absent, it inherits the current session model.
