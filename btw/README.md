# BTW

Background Task Worker for magpie.

## What it does

- Adds `/btw <prompt>`
- Runs one background subagent while you keep working
- Defaults to rush-like routing unless `-mode` or `-model` is provided
- Uses the shared magpie subagent core
- Shows a progress widget above the editor
- Posts the final result back into chat as a custom message
- Keeps btw results out of the main agent context

## Usage

```bash
/btw check whether there are any TODO comments in src/
/btw -mode smart summarize the README
/btw -mode deep inspect the latest refactor for edge cases
/btw -model github-copilot/gpt-5-mini count lines of code in the repo
```

## Config

BTW reads mode and subagent routing from the shared magpie config:

- Global: `~/.pi/agent/magpie.json`
- Project: `.pi/magpie.json`
