# web-fetch

A Pi extension that adds a `web_fetch` tool for fetching web page content as markdown.

## How it works

The tool curls `https://defuddle.md/{url}` which returns the full page content
extracted as clean markdown. When the agent calls `web_fetch`, it runs:

```
curl -sL https://defuddle.md/<url>
```

The markdown output is returned to the Pi agent as tool results.

## Requirements

- `curl` installed and in PATH
- Internet access to defuddle.md

## Parameters

| Parameter | Type   | Description                                  |
|-----------|--------|----------------------------------------------|
| `url`     | string | The URL to fetch (http or https)             |

## Installation

```bash
# Global
cp web-fetch.ts ~/.pi/agent/extensions/web-fetch.ts

# Project-local
mkdir -p .pi/extensions
cp web-fetch.ts .pi/extensions/web-fetch.ts
```

Then reload Pi (`/reload`) or restart.
