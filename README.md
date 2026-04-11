# magpie

A collection of custom tools and extensions for [Pi](https://pi.dev).

These extend Pi with capabilities that do not ship by default, built as Pi extensions using the extension API.

## Tools

| Directory | Description |
|-----------|-------------|
| [`custom-modes/`](custom-modes/) | Single-active-mode manager with `/mode`, Amp-like smart/rush/deep semantics, and JSON-configurable custom modes |
| [`handoff/`](handoff/) | Transfer context to a new session using an LLM-generated handoff prompt |
| [`session-query/`](session-query/) | Query previous Pi sessions for decisions, file changes, and historical context |
| [`btw/`](btw/) | Background single-task subagent command (`/btw`) with rush-by-default mode routing |
| [`plan-mode/`](plan-mode/) | Planning loop with subagents, user questions, and deterministic plan files |
| [`spinner/`](spinner/) | Spinner that shows random verbs during streaming |
| [`web-fetch/`](web-fetch/) | Fetch a web page and return its content as markdown via defuddle.md |
| [`web-search/`](web-search/) | Web search tool that delegates to OpenCode with Exa enabled |


See each tool's README for detailed usage, configuration, and requirements.

## Requirements

- Pi (the terminal coding agent)
- Some tools have additional dependencies (see individual READMEs)

## Installation

Use the install script to symlink all tools into your global Pi extensions directory:

```bash
./install.sh
```

This copies each tool directory to `~/.pi/agent/extensions/` (as `<name>.ts/`). If an extension with the same name already exists, the script will skip it and print a warning.

To install to a custom location:

```bash
./install.sh /path/to/extensions
```

To install manually (per-tool or project-local):

```bash
# Global (example)
cp -r custom-modes ~/.pi/agent/extensions/custom-modes.ts

# Project-local (example)
mkdir -p .pi/extensions
cp -r custom-modes .pi/extensions/custom-modes.ts
```

Then reload Pi (`/reload`) or restart.

## License

MIT
