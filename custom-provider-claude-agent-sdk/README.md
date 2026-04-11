# Claude Agent SDK Provider

A Pi extension that provides access to Claude models via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript), which uses your Anthropic subscription through Claude Code.

## Features

- Access to Claude Opus, Sonnet, and Haiku models
- Uses your existing Claude CLI authentication (no API key needed)
- Full streaming support with tool calls and reasoning
- Integrates with Pi's handoff system for cross-provider workflows

## Prerequisites

1. **Claude CLI installed and authenticated**:
   ```bash
   # Install Claude CLI
   npm install -g @anthropic-ai/claude-code
   
   # Authenticate
   claude auth login
   ```

2. **Anthropic subscription** (Pro, Max, or Enterprise)

## Models

| Model | Description | Reasoning |
|-------|-------------|-----------|
| `claude-opus-4-6` | Most capable, best for complex tasks | ✓ |
| `claude-sonnet-4-6` | Balanced performance and cost | ✓ |
| `claude-haiku-4-5` | Fast, cost-effective for simple tasks | ✗ |

## Usage

### Start Pi with the extension

```bash
pi -e ./custom-provider-claude-agent-sdk
```

### Use a specific model

```bash
pi -e ./custom-provider-claude-agent-sdk --provider claude-agent-sdk --model claude-sonnet-4-6
```

### In-session model selection

Once Pi is running, use `/model` to switch:
```
/model claude-agent-sdk/claude-opus-4-6
```

## Important Notes

- **Model lock-in**: Once a thread starts with this provider, the model is locked for that thread (the SDK manages its own session state)
- **Handoff**: Use `/handoff` to transfer context to a different provider when needed
- **Authentication**: Uses your existing Claude CLI authentication - no additional setup required

## Example

```bash
# Start Pi with Claude Agent SDK
pi -e ./custom-provider-claude-agent-sdk --provider claude-agent-sdk --model claude-sonnet-4-6

# In Pi, you can now use Claude with full tool access
> Help me refactor this codebase
```

## Troubleshooting

If you see authentication errors:
```bash
# Verify Claude CLI is authenticated
claude auth status

# Re-authenticate if needed
claude auth login
```
