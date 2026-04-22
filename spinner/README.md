# Spinner

Replaces the default "Working..." message with random verbs that rotate every 6-10 seconds.

## Usage

```
pi --extension spinner/spinner.ts
```

## What it does

Instead of always seeing "Working...", you'll get random verbs like:
- Brewing...
- Crafting...
- Reticulating...
- Noodling...

The verb changes every 6-10 seconds while the agent is streaming.

## Customization

Edit the `SPINNER_VERBS` array in `spinner.ts` to add/remove words.

## Installation

```bash
# Global
cp -r "$(pwd)/spinner" ~/.pi/agent/extensions/spinner.ts

# Project-local
mkdir -p .pi/extensions
cp -r "$(pwd)/spinner" .pi/extensions/spinner.ts
```

Then reload Pi (`/reload`) or restart.
