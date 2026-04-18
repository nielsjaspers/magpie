# Research

Research companion extension for Magpie.

It currently provides two slash commands:
- `/papers [-limit <1-20>] <query>`
- `/digest <query>`

## What it does

`/papers` searches Semantic Scholar, stores paper metadata on disk, fetches paper markdown with Defuddle, and falls back to arxiv2md for compatible arXiv papers when Defuddle fails.

`/digest` resolves a saved paper from a natural-language query using an internal research-only subagent, then starts a Socratic reading session in the current branch. It injects a specialised digest prompt into that branch, writes a per-session transcript to disk, and rebuilds an `answers.md` file from the accumulated user answers.

## Configuration

Add a `research` block to Magpie config:

```json
{
  "research": {
    "papersDir": "~/personal/magpie-papers",
    "resolverSubagent": {
      "model": "github-copilot/gpt-5-mini",
      "thinkingLevel": "low"
    }
  }
}
```

Notes:
- `papersDir` supports `~` expansion at runtime.
- `resolverSubagent` is internal to this extension. It is not exposed as a public Magpie subagent tool.

## Auth

Provider API keys live in `magpie.auth.json`, not in the normal Magpie config file.

Scopes:
- global: `~/.pi/agent/magpie.auth.json`
- project: `.pi/magpie.auth.json`

Project auth overrides global auth.

Current auth keys:
- `semanticScholar.apiKey` for `/papers`
- `exa.apiKey` reserved for future integrations

Example:

```json
{
  "semanticScholar": {
    "apiKey": "your-semantic-scholar-api-key"
  }
}
```

## Directory layout

Papers are stored under `research.papersDir` like this:

```text
<research.papersDir>/
  vas17-attention/
    metadata.json
    paper.md
    digest/
      session-2026-04-18T14-32-10Z.md
      answers.md
```

## Runtime files

The digest prompt used at runtime lives in this directory:
- `research/digest-prompt.md`

Design material in `.pi/context/` is reference-only and is not used by the extension at runtime.

## Current v1 behavior

- slash commands only
- no public research tools
- no separate digest mode
- no separate managed digest session
- Defuddle first, arxiv2md fallback
- digest continues in the current conversation branch

## Files

- `index.ts` — command registration and digest branch hooks
- `providers.ts` — Semantic Scholar, Defuddle, arxiv2md
- `storage.ts` — paper and digest filesystem persistence
- `digest.ts` — resolver flow, prompt loading, digest persistence helpers
- `types.ts` — shared research types
