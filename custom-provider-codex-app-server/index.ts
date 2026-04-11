/**
 * Codex App Server Provider for Pi
 *
 * Provides access to OpenAI models via the Codex App Server,
 * which uses your ChatGPT/OpenAI subscription through Codex.
 *
 * Usage:
 *   pi -e ./custom-provider-codex-app-server
 *
 * Then use /model to select codex-app-server/gpt-5.4
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
  type StopReason,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

// =============================================================================
// Types
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface CodexModel {
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

const CODEX_MODELS: CodexModel[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Codex App Server)",
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.1",
    name: "GPT-5.1 (Codex App Server)",
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "o3",
    name: "o3 (Codex App Server)",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 100000,
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  },
  {
    id: "o4-mini",
    name: "o4-mini (Codex App Server)",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 100000,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  },
];

// =============================================================================
// JSON-RPC Client
// =============================================================================

class CodexAppServerClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  private rl: readline.Interface | null = null;

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error("Failed to start codex app-server");
    }

    this.rl = readline.createInterface({ input: this.proc.stdout });

    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if ("id" in msg && msg.id !== undefined) {
          // Response to a request
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result ?? {});
            }
          }
        } else if ("method" in msg) {
          // Notification
          for (const handler of this.notificationHandlers) {
            handler(msg as JsonRpcNotification);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    this.proc.on("close", () => {
      this.proc = null;
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error("Codex app-server closed"));
      }
      this.pendingRequests.clear();
    });

    // Initialize
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "pi-codex-provider",
        title: "Pi Codex Provider",
        version: "1.0.0",
      },
    });
    await this.sendNotification("initialized", {});
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.proc?.stdin) throw new Error("Not connected");

    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error("Not connected");
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(notification) + "\n");
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandlers.add(handler);
  }

  offNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandlers.delete(handler);
  }

  async startThread(model: string, cwd: string, developerInstructions?: string): Promise<{ threadId: string }> {
    const params: Record<string, unknown> = {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    
    // Pass system prompt as developer instructions
    if (developerInstructions) {
      params.developerInstructions = developerInstructions;
    }
    
    const result = await this.sendRequest("thread/start", params);
    const thread = result.thread as { id: string };
    return { threadId: thread.id };
  }

  async startTurn(
    threadId: string,
    input: Array<{ type: string; text?: string }>,
  ): Promise<{ turnId: string }> {
    const result = await this.sendRequest("turn/start", {
      threadId,
      input,
    });
    const turn = result.turn as { id: string };
    return { turnId: turn.id };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.sendRequest("turn/interrupt", { threadId, turnId });
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

// =============================================================================
// Message Conversion
// =============================================================================

function convertPiMessagesToCodexInput(
  messages: Context["messages"],
): Array<{ type: string; text: string }> {
  const input: Array<{ type: string; text: string }> = [];

  // Convert messages to text input
  // Note: System prompt is passed via developerInstructions, not in input
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("\n");

      if (text.trim()) {
        input.push({ type: "text", text });
      }
    } else if (msg.role === "assistant") {
      // Include assistant context
      const textParts = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);

      if (textParts.length > 0) {
        input.push({ type: "text", text: `[Assistant]: ${textParts.join("\n")}` });
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");

      input.push({ type: "text", text: `[Tool result for ${msg.toolName}]: ${text}` });
    }
  }

  return input;
}

// =============================================================================
// Streaming Implementation
// =============================================================================

function streamCodexAppServer(
  model: { id: string; api: Api; provider: string; reasoning: boolean; maxTokens: number },
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let client: CodexAppServerClient | null = null;

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
      client = new CodexAppServerClient();
      await client.start();

      // Start thread with system prompt as developer instructions
      const { threadId } = await client.startThread(model.id, process.cwd(), context.systemPrompt);

      // Convert messages to Codex format
      // Note: system prompt is passed via developerInstructions, not in input
      const input = convertPiMessagesToCodexInput(context.messages);

      // Set up notification handler
      let currentTurnId: string | null = null;
      let textBlockIndex = -1;
      let reasoningBlockIndex = -1;

      const notificationHandler = (notification: JsonRpcNotification) => {
        // Check for abort
        if (options?.signal?.aborted && currentTurnId) {
          client?.interruptTurn(threadId, currentTurnId);
          return;
        }

        switch (notification.method) {
          case "turn/started": {
            const turn = notification.params?.turn as { id: string } | undefined;
            if (turn) {
              currentTurnId = turn.id;
            }
            break;
          }

          case "turn/completed": {
            const turn = notification.params?.turn as { status?: string } | undefined;
            if (turn?.status === "interrupted") {
              output.stopReason = "aborted";
            } else if (turn?.status === "failed") {
              output.stopReason = "error";
              output.errorMessage = "Turn failed";
            }
            break;
          }

          case "item/started": {
            const item = notification.params?.item as { type?: string; id?: string } | undefined;
            if (item?.type === "agentMessage") {
              output.content.push({ type: "text", text: "" });
              textBlockIndex = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
            } else if (item?.type === "reasoning") {
              output.content.push({ type: "thinking", thinking: "" });
              reasoningBlockIndex = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: reasoningBlockIndex, partial: output });
            } else if (item?.type === "commandExecution") {
              const command = (item as { command?: string }).command || "command";
              output.content.push({
                type: "toolCall",
                id: item.id || `cmd-${Date.now()}`,
                name: "Bash",
                arguments: { command },
              });
              const idx = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
              stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: output.content[idx] as any, partial: output });
            }
            break;
          }

          case "item/agentMessage/delta": {
            const delta = notification.params?.delta as string | undefined;
            if (delta && textBlockIndex >= 0) {
              const block = output.content[textBlockIndex];
              if (block?.type === "text") {
                block.text += delta;
                stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta, partial: output });
              }
            }
            break;
          }

          case "item/reasoning/summaryTextDelta": {
            const delta = notification.params?.delta as string | undefined;
            if (delta && reasoningBlockIndex >= 0) {
              const block = output.content[reasoningBlockIndex];
              if (block?.type === "thinking") {
                block.thinking += delta;
                stream.push({ type: "thinking_delta", contentIndex: reasoningBlockIndex, delta, partial: output });
              }
            }
            break;
          }

          case "item/completed": {
            const item = notification.params?.item as { type?: string; text?: string } | undefined;
            if (item?.type === "agentMessage" && textBlockIndex >= 0) {
              const block = output.content[textBlockIndex];
              if (block?.type === "text") {
                stream.push({
                  type: "text_end",
                  contentIndex: textBlockIndex,
                  content: block.text,
                  partial: output,
                });
              }
              textBlockIndex = -1;
            } else if (item?.type === "reasoning" && reasoningBlockIndex >= 0) {
              const block = output.content[reasoningBlockIndex];
              if (block?.type === "thinking") {
                stream.push({
                  type: "thinking_end",
                  contentIndex: reasoningBlockIndex,
                  content: block.thinking,
                  partial: output,
                });
              }
              reasoningBlockIndex = -1;
            }
            break;
          }

          case "thread/tokenUsage/updated": {
            const usage = notification.params?.usage as {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            } | undefined;
            if (usage) {
              output.usage.input = usage.inputTokens || 0;
              output.usage.output = usage.outputTokens || 0;
              output.usage.totalTokens = usage.totalTokens || 0;
            }
            break;
          }
        }
      };

      client.onNotification(notificationHandler);

      stream.push({ type: "start", partial: output });

      // Start the turn
      const { turnId } = await client.startTurn(threadId, input);
      currentTurnId = turnId;

      // Wait for turn to complete (poll for completion)
      let completed = false;
      const checkInterval = setInterval(() => {
        if (output.stopReason !== "stop" || options?.signal?.aborted) {
          completed = true;
        }
      }, 100);

      // Wait for completion or timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          completed = true;
          resolve();
        }, 300000); // 5 minute timeout

        const checker = setInterval(() => {
          if (completed || options?.signal?.aborted) {
            clearTimeout(timeout);
            clearInterval(checker);
            resolve();
          }
        }, 100);
      });

      clearInterval(checkInterval);
      client.offNotification(notificationHandler);

      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
      } else {
        const finalReason = output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "error" ? "error" : "stop";
        if (finalReason === "error") {
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          stream.push({
            type: "done",
            reason: finalReason as "stop" | "toolUse",
            message: output,
          });
        }
      }

      stream.end();
    } catch (error) {
      output.stopReason = "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    } finally {
      client?.close();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // Register the Codex App Server provider
  pi.registerProvider("codex-app-server", {
    // baseUrl is not used - app-server handles its own transport
    baseUrl: "codex-app-server://local",
    // Placeholder - app-server uses CLI auth
    apiKey: "CODEX_APP_SERVER_USES_CLI_AUTH",
    api: "codex-app-server",
    models: CODEX_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text", "image"] as const,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    streamSimple: streamCodexAppServer as any,
  });

  // Log that the extension loaded
  console.log("[Codex App Server] Provider registered with models:", CODEX_MODELS.map((m) => m.id).join(", "));
}
