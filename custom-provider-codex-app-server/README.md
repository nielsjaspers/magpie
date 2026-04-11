# Codex App Server Provider

A Pi extension that provides access to OpenAI models via the [Codex App Server](https://developers.openai.com/codex/app-server), which uses your ChatGPT/OpenAI subscription through Codex.

## Features

- Access to GPT-5.4, GPT-5.1, o3, and o4-mini models
- Uses your existing Codex CLI authentication
- Full streaming support with tool calls and reasoning
- Integrates with Pi's handoff system for cross-provider workflows

## Prerequisites

1. **Codex CLI installed and authenticated**:
   ```bash
   # Install Codex CLI
   npm install -g @openai/codex
   
   # Login with ChatGPT or API key
   codex login
   ```

2. **ChatGPT subscription** (Plus, Pro, or Team) or **OpenAI API key**

## Models

| Model | Description | Reasoning |
|-------|-------------|-----------|
| `gpt-5.4` | Latest GPT model | ✓ |
| `gpt-5.1` | Previous generation GPT | ✓ |
| `o3` | Optimized reasoning model | ✓ |
| `o4-mini` | Fast reasoning model | ✓ |

## Usage

### Start Pi with the extension

```bash
pi -e ./custom-provider-codex-app-server
```

### Use a specific model

```bash
pi -e ./custom-provider-codex-app-server --provider codex-app-server --model gpt-5.4
```

### In-session model selection

Once Pi is running, use `/model` to switch:
```
/model codex-app-server/gpt-5.4
```

## Important Notes

- **Model lock-in**: Once a thread starts with this provider, the model is locked for that thread (the app-server manages its own session state)
- **Handoff**: Use `/handoff` to transfer context to a different provider when needed
- **Authentication**: Uses your existing Codex CLI authentication - no additional setup required

## Example

```bash
# Start Pi with Codex App Server
pi -e ./custom-provider-codex-app-server --provider codex-app-server --model gpt-5.4

# In Pi, you can now use GPT with full tool access
> Help me implement this feature
```

## Troubleshooting

If you see authentication errors:
```bash
# Verify Codex CLI is working
codex --help

# Re-authenticate if needed
codex login
```

## JSON-RPC Protocol

This extension uses the Codex App Server's JSON-RPC protocol over stdio. The extension:
1. Spawns `codex app-server` as a subprocess
2. Communicates via JSON-RPC 2.0 messages
3. Streams notifications for real-time updates

For more details, see the [Codex App Server documentation](https://developers.openai.com/codex/app-server).
