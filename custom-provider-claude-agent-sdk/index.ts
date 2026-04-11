/**
 * Claude Agent SDK Provider for Pi
 *
 * Provides access to Claude models via the Claude Agent SDK,
 * which uses your Anthropic subscription through Claude Code.
 *
 * Usage:
 *   pi -e ./custom-provider-claude-agent-sdk
 *
 * Then use /model to select claude-agent-sdk/claude-sonnet-4-6
 *
 * Note: Once a thread starts with this provider, the model is locked
 * for that thread. Use /handoff to transfer context to a different provider.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

// =============================================================================
// Types
// =============================================================================

interface ClaudeAgentSDKModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// =============================================================================
// Model Definitions
// =============================================================================

const CLAUDE_MODELS: ClaudeAgentSDKModel[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Agent SDK)",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Agent SDK)",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 16000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (Agent SDK)",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
];

// =============================================================================
// Message Conversion: Pi → SDK
// =============================================================================

/**
 * Convert pi messages to SDK user messages format.
 * The SDK expects an AsyncIterable<SDKUserMessage>, so we need to
 * reconstruct the conversation in SDK format.
 * 
 * Note: System prompt is passed via SDK options, not as a message.
 */
function* convertPiMessagesToSdkGenerator(
  messages: Context["messages"],
): Generator<SDKUserMessage> {
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("\n");

      if (content.trim()) {
        yield {
          type: "user",
          message: {
            role: "user",
            content: content,
          },
          parent_tool_use_id: null,
        };
      }
    } else if (msg.role === "assistant") {
      // Convert assistant messages to user messages with a marker
      // The SDK needs to see the full conversation history
      const textParts: string[] = [];
      const toolUseParts: Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          toolUseParts.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
        }
      }

      if (textParts.length > 0 || toolUseParts.length > 0) {
        // For SDK, we include assistant messages as context
        // This helps maintain conversation continuity
        const contentParts: Array<{ type: "text"; text: string } | {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        }> = [];

        for (const text of textParts) {
          contentParts.push({ type: "text", text });
        }
        for (const tool of toolUseParts) {
          contentParts.push(tool);
        }

        yield {
          type: "user",
          message: {
            role: "user",
            content: `[Previous assistant response]: ${textParts.join("\n") || "(tool calls only)"}`,
          },
          parent_tool_use_id: null,
        };
      }
    } else if (msg.role === "toolResult") {
      // Convert tool results to user messages
      const content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");

      yield {
        type: "user",
        message: {
          role: "user",
          content: `[Tool result for ${msg.toolName}]:\n${content || "(empty result)"}`,
        },
        parent_tool_use_id: null,
      };
    }
  }
}

/**
 * Create an AsyncIterable from messages for the SDK query function
 */
function createSdkPromptIterable(
  messages: Context["messages"],
): AsyncIterable<SDKUserMessage> {
  const generator = convertPiMessagesToSdkGenerator(messages);

  return {
    [Symbol.asyncIterator]() {
      const iter = generator[Symbol.iterator]();
      return {
        async next() {
          const result = iter.next();
          if (result.done) {
            return { done: true as const, value: undefined };
          }
          return { done: false as const, value: result.value };
        },
      };
    },
  };
}

// =============================================================================
// Streaming Implementation
// =============================================================================

function streamClaudeAgentSDK(
  model: { id: string; api: Api; provider: string; reasoning: boolean; maxTokens: number },
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Create the prompt iterable from pi messages
      // Note: system prompt is passed via SDK options, not in messages
      const prompt = createSdkPromptIterable(context.messages);

      // Start the SDK query
      const q = query({
        prompt,
        options: {
          model: model.id,
          permissionMode: "bypassPermissions",
          cwd: process.cwd(),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(context.systemPrompt ? { append: context.systemPrompt } : {}),
          },
          tools: {
            type: "preset",
            preset: "claude_code",
          },
          includePartialMessages: true,
          signal: options?.signal,
          // Use setting sources to load CLAUDE.md files
          settingSources: ["user", "project", "local"],
        },
      });

      stream.push({ type: "start", partial: output });

      // Track content blocks by their SDK index
      const blockIndexMap = new Map<number, number>();
      let currentThinkingIndex = -1;

      // Process SDK messages
      for await (const message of q) {
        if (options?.signal?.aborted) {
          await q.interrupt();
          break;
        }

        if (message.type === "stream_event") {
          // Handle streaming events
          const event = message as SDKPartialAssistantMessage;
          const streamEvent = event.event;

          if (streamEvent.type === "content_block_start") {
            const block = streamEvent.content_block;
            if (block.type === "text") {
              output.content.push({ type: "text", text: "" });
              const contentIndex = output.content.length - 1;
              blockIndexMap.set(streamEvent.index, contentIndex);
              stream.push({ type: "text_start", contentIndex, partial: output });
            } else if (block.type === "thinking") {
              output.content.push({ type: "thinking", thinking: "" });
              const contentIndex = output.content.length - 1;
              blockIndexMap.set(streamEvent.index, contentIndex);
              currentThinkingIndex = contentIndex;
              stream.push({ type: "thinking_start", contentIndex, partial: output });
            } else if (block.type === "tool_use") {
              output.content.push({
                type: "toolCall",
                id: block.id,
                name: block.name,
                arguments: {},
              });
              const contentIndex = output.content.length - 1;
              blockIndexMap.set(streamEvent.index, contentIndex);
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
            }
          } else if (streamEvent.type === "content_block_delta") {
            const contentIndex = blockIndexMap.get(streamEvent.index);
            if (contentIndex === undefined) continue;

            const block = output.content[contentIndex];
            if (!block) continue;

            if (streamEvent.delta.type === "text_delta" && block.type === "text") {
              block.text += streamEvent.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex,
                delta: streamEvent.delta.text,
                partial: output,
              });
            } else if (streamEvent.delta.type === "thinking_delta" && block.type === "thinking") {
              block.thinking += streamEvent.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex,
                delta: streamEvent.delta.thinking,
                partial: output,
              });
            } else if (streamEvent.delta.type === "input_json_delta" && block.type === "toolCall") {
              // Accumulate JSON for tool arguments
              const partialJson = streamEvent.delta.partial_json;
              try {
                // Try to parse accumulated JSON
                if (partialJson) {
                  const currentJson = JSON.stringify(block.arguments) === "{}"
                    ? ""
                    : JSON.stringify(block.arguments);
                  block.arguments = JSON.parse(currentJson + partialJson);
                }
              } catch {
                // JSON is still being built
              }
              stream.push({
                type: "toolcall_delta",
                contentIndex,
                delta: partialJson,
                partial: output,
              });
            }
          } else if (streamEvent.type === "content_block_stop") {
            const contentIndex = blockIndexMap.get(streamEvent.index);
            if (contentIndex === undefined) continue;

            const block = output.content[contentIndex];
            if (!block) continue;

            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex,
                content: block.thinking,
                partial: output,
              });
              currentThinkingIndex = -1;
            } else if (block.type === "toolCall") {
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (message.type === "assistant") {
          // Full assistant message - extract usage info
          const sdkMsg = message as SDKAssistantMessage;
          if (sdkMsg.message?.usage) {
            output.usage.input = sdkMsg.message.usage.input_tokens || 0;
            output.usage.output = sdkMsg.message.usage.output_tokens || 0;
            output.usage.cacheRead = sdkMsg.message.usage.cache_read_input_tokens || 0;
            output.usage.cacheWrite = sdkMsg.message.usage.cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }

          // Check stop reason
          if (sdkMsg.message?.stop_reason === "tool_use") {
            output.stopReason = "toolUse";
          } else if (sdkMsg.message?.stop_reason === "max_tokens") {
            output.stopReason = "length";
          }
        } else if (message.type === "result") {
          // Final result message
          const resultMsg = message as SDKResultMessage;

          // Update usage from result
          if (resultMsg.usage) {
            output.usage.input = resultMsg.usage.input_tokens || 0;
            output.usage.output = resultMsg.usage.output_tokens || 0;
            output.usage.cacheRead = resultMsg.usage.cache_read_input_tokens || 0;
            output.usage.cacheWrite = resultMsg.usage.cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }

          if (resultMsg.is_error) {
            output.stopReason = "error";
            output.errorMessage = resultMsg.errors?.join(", ") || "Unknown error";
          }
        }
      }

      // Close the query
      q.close();

      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else if (output.stopReason === "error") {
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        const finalReason = output.stopReason === "toolUse" ? "toolUse" : "stop";
        stream.push({
          type: "done",
          reason: finalReason as "stop" | "toolUse",
          message: output,
        });
      }

      stream.end();
    } catch (error) {
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // Register the Claude Agent SDK provider
  // Note: apiKey is a placeholder - actual auth is handled by Claude CLI
  pi.registerProvider("claude-agent-sdk", {
    // baseUrl is not used - SDK handles its own transport
    baseUrl: "claude-agent-sdk://local",
    // Placeholder - SDK uses CLI auth, not API keys
    apiKey: "CLAUDE_AGENT_SDK_USES_CLI_AUTH",
    api: "claude-agent-sdk",
    models: CLAUDE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text", "image"] as const,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    streamSimple: streamClaudeAgentSDK as any,
  });

  // Log that the extension loaded
  console.log("[Claude Agent SDK] Provider registered with models:", CLAUDE_MODELS.map(m => m.id).join(", "));
}
