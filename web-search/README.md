# web-search

A Pi extension that adds a `web_search` tool for searching the web from within Pi.

## How it works

The tool delegates to the `opencode` CLI with Exa search enabled. When the
agent calls `web_search`, it runs:

```
OPENCODE_ENABLE_EXA=1 opencode run "<query>" --model "github-copilot/gemini-3-flash-preview"
```

The output from OpenCode is returned to the Pi agent as tool results.

## Requirements

- `opencode` CLI installed and in PATH
- Exa search access configured through OpenCode
- Pi extension system

## Parameters

| Parameter | Type   | Description             |
|-----------|--------|------------------------|
| `query`   | string | The search query to run |

## Configuration

The model used for search can be changed by editing the `--model` flag in
`web-search.ts`. The default is `github-copilot/gemini-3-flash-preview`.

Timeout is set to 120 seconds. Edit the `timeout` value in the `pi.exec` call
if you need to adjust it.

## Installation

```bash
# Global
ln -sf "$(pwd)/web-search" ~/.pi/agent/extensions/web-search

# Project-local
mkdir -p .pi/extensions
ln -sf "$(pwd)/web-search" .pi/extensions/web-search
```

Then reload Pi (`/reload`) or restart.
