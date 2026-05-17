import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { MagpieConfig } from "../config/types.js";
import { resolveModel, resolveSubagentModel, resolveSubagentPrompt } from "../config/config.js";
import { resolveSubagentHeaders } from "./headers.js";
import type { DisplayItem, SubagentProgress, SubagentResult, SubagentSpec, UsageStats } from "./types.js";

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function defaultPromptFor(spec: SubagentSpec): string {
	if (spec.systemPrompt?.trim()) return spec.systemPrompt.trim();
	if (spec.role === "handoff") {
		return "You are a context transfer worker. Read the provided conversation history and produce a self-contained handoff prompt for a new pi session focused on the stated goal. Preserve concrete files, decisions, constraints, failed attempts, unresolved issues, and user preferences. Omit irrelevant back-and-forth and assistant filler. Output only the handoff content.";
	}
	if (spec.role === "session") {
		return "You are a session retrieval worker. Answer questions about a previous pi session using only the supplied session contents. Be specific, cite concrete files/tools/decisions when present, and say when the session does not contain enough information.";
	}
	if (spec.role === "commit") {
		return "You are a git commit worker. Inspect git status, recent commit style, and the current diff. Create one coherent commit when appropriate, report the hash/message, and explain clearly if a clean commit cannot be made. Do not edit files directly.";
	}
	if (spec.role === "memory") {
		return "You are a memory worker. Retrieve, triage, or consolidate user memory from human-readable files. Ground claims in the provided materials, avoid invented facts, and keep outputs compact and operational.";
	}
	if (spec.role === "schedule") {
		return "You are a scheduled-task worker. Complete the requested task directly, report the result, and avoid conversational filler.";
	}
	return "You are a delegate subagent for focused investigation and reasoning. You have read-only tools available: read, bash, grep, find, and ls. For any question about filesystem state, files, directories, command output, or repository contents, you must inspect with tools before answering; do not answer from assumption. Absolute paths such as /tmp are allowed. Answer the task precisely, include concrete file paths or evidence when useful, do not edit files, and do not spawn further agents.";
}

function getToolList(tools: SubagentSpec["tools"]): string[] {
	if (tools === "readonly" || tools === undefined) {
		return ["read", "bash", "grep", "find", "ls"];
	}
	if (tools === "full") {
		return ["read", "bash", "grep", "find", "ls", "edit", "write"];
	}
	const builtIns = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);
	return tools.filter((name): name is string => builtIns.has(name));
}

function createResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function toModelString(model: any): string {
	return model?.provider && model?.id ? `${model.provider}/${model.id}` : "unknown";
}

function updateUsageFromMessage(usage: UsageStats, message: any) {
	const u = message?.usage;
	if (!u) return;
	usage.input += u.input || 0;
	usage.output += u.output || 0;
	usage.cacheRead += u.cacheRead || 0;
	usage.cacheWrite += u.cacheWrite || 0;
	usage.cost += u.cost?.total || 0;
	usage.contextTokens = u.totalTokens || usage.contextTokens;
	usage.turns += 1;
}

function getCurrentThinkingLevel(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries() as Array<{ type: string; thinkingLevel?: string }>;
	return entries.filter((entry) => entry.type === "thinking_level_change").pop()?.thinkingLevel;
}

export async function runSubagent(
	ctx: ExtensionContext,
	config: MagpieConfig,
	spec: SubagentSpec,
	signal?: AbortSignal,
	onProgress?: (progress: SubagentProgress) => void,
): Promise<SubagentResult> {
	const resolved = spec.model
		? { model: spec.model, thinkingLevel: spec.thinkingLevel as any }
		: resolveSubagentModel(config, spec.role);
	const runtimeModel = resolveModel(ctx, resolved?.model) ?? (ctx.model as any);
	if (!runtimeModel) {
		return {
			spec,
			output: "",
			displayItems: [],
			exitCode: 1,
			usage: emptyUsage(),
			model: resolved?.model ?? "unknown",
			errorMessage: "No model available for subagent.",
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(runtimeModel);
	if (!auth.ok) {
		return {
			spec,
			output: "",
			displayItems: [],
			exitCode: 1,
			usage: emptyUsage(),
			model: toModelString(runtimeModel),
			errorMessage: "No usable auth available for subagent model.",
		};
	}

	const headers = resolveSubagentHeaders(auth.headers, runtimeModel, true);
	const modelForSession = { ...runtimeModel, headers };
	const usage = emptyUsage();
	const displayItems: DisplayItem[] = [];
	const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];
	let output = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	const baseSystemPrompt = spec.systemPrompt?.trim() || defaultPromptFor(spec);
	const promptOverride = await resolveSubagentPrompt(config, ctx.cwd, spec.role);
	const systemPrompt = promptOverride
		? promptOverride.strategy === "replace"
			? promptOverride.text
			: `${baseSystemPrompt}\n\n${promptOverride.text}`
		: baseSystemPrompt;
	const taskText = [spec.context?.trim(), spec.task.trim()].filter(Boolean).join("\n\n");
	const resourceLoader = createResourceLoader(systemPrompt);

	try {
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			model: modelForSession,
			thinkingLevel: (spec.thinkingLevel as any) ?? resolved?.thinkingLevel ?? getCurrentThinkingLevel(ctx) ?? "medium",
			tools: getToolList(spec.tools) as any,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: ctx.modelRegistry,
		});
		await session.bindExtensions({});

		session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				output += event.assistantMessageEvent.delta ?? "";
				onProgress?.({ turns: usage.turns, toolCalls: [...toolCalls], partialOutput: output, usage: { ...usage } });
				return;
			}
			if (event.type === "tool_execution_start") {
				toolCalls.push({ name: event.toolName, args: event.args ?? {} });
				displayItems.push({ type: "toolCall", name: event.toolName, args: event.args ?? {} });
				onProgress?.({ turns: usage.turns, toolCalls: [...toolCalls], partialOutput: output, usage: { ...usage } });
				return;
			}
			if (event.type === "message_end") {
				const message = event.message as any;
				if (message?.role === "assistant") {
					updateUsageFromMessage(usage, message);
					if (message.stopReason) stopReason = message.stopReason;
					if (message.errorMessage) errorMessage = message.errorMessage;
					const textParts = Array.isArray(message.content)
						? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text)
						: [];
					const text = textParts.join("\n").trim();
					if (text) {
						output = text;
						displayItems.push({ type: "text", text });
					}
					onProgress?.({ turns: usage.turns, toolCalls: [...toolCalls], partialOutput: output, usage: { ...usage } });
				}
			}
		});

		await session.prompt(taskText);
		return {
			spec,
			output,
			displayItems,
			exitCode: stopReason === "error" ? 1 : 0,
			usage,
			model: toModelString(modelForSession),
			errorMessage,
			stopReason,
		};
	} catch (error) {
		return {
			spec,
			output,
			displayItems,
			exitCode: signal?.aborted ? 1 : 1,
			usage,
			model: toModelString(modelForSession),
			errorMessage: error instanceof Error ? error.message : String(error),
			stopReason: signal?.aborted ? "aborted" : "error",
		};
	}
}

export async function runSubagentBatch(
	ctx: ExtensionContext,
	config: MagpieConfig,
	specs: SubagentSpec[],
	signal?: AbortSignal,
	onProgress?: (index: number, progress: SubagentProgress) => void,
): Promise<SubagentResult[]> {
	return Promise.all(
		specs.map((spec, index) => runSubagent(ctx, config, spec, signal, (progress) => onProgress?.(index, progress))),
	);
}
