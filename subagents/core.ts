import {
	createAgentSession,
	createBashTool,
	createEditTool,
	createExtensionRuntime,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	SessionManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { MagpieConfig } from "../config/types.js";
import { resolveModel, resolveSubagentModel } from "../config/config.js";
import { resolveSubagentHeaders } from "./headers.js";
import type { DisplayItem, SubagentProgress, SubagentResult, SubagentSpec, UsageStats } from "./types.js";

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function defaultPromptFor(spec: SubagentSpec): string {
	if (spec.systemPrompt?.trim()) return spec.systemPrompt.trim();
	if (spec.role === "search") {
		return "You are a fast codebase retrieval agent. Find relevant files, symbols, call paths, and patterns. Use grep, find, and read. Be precise, include exact file paths, and keep output concise. Do not modify any files.";
	}
	if (spec.role === "oracle") {
		return "You are a reasoning agent for complex code analysis. Trace dependencies, surface assumptions, evaluate tradeoffs, and validate approaches. Use read and search tools to gather evidence before forming conclusions. Be thorough but structured.";
	}
	if (spec.role === "librarian") {
		return "You are a research agent for external code and documentation. Investigate external APIs, documentation sites, and historical context. Use web_search, web_fetch, read, and grep when available. Cite sources and clearly separate facts from inferences.";
	}
	if (spec.role === "plan") {
		if (spec.planSubRole === "design") {
			return "You are a design subagent. Propose implementation approaches based on evidence. Compare 1-2 viable approaches with tradeoffs.";
		}
		if (spec.planSubRole === "risk") {
			return "You are a risk subagent. Identify failure modes, edge cases, regressions, and missing test coverage. Highlight unknown assumptions.";
		}
		return "You are an explore subagent. Investigate the codebase to answer a specific question. Read-only. Include concrete evidence with file paths.";
	}
	if (spec.role === "handoff") {
		return "You are a context transfer assistant. Read the conversation history and extract the information relevant to the stated goal for a new session. Do not summarize. Restructure relevant context into a self-contained prompt.";
	}
	if (spec.role === "session") {
		return "You are a session context assistant. Given conversation history from a pi session and a question, provide a concise, factual answer based on the session contents.";
	}
	if (spec.role === "memory") {
		return "You are a memory consolidation assistant. Extract key facts, decisions, preferences, and project context from the conversation. Output concise structured entries.";
	}
	if (spec.role === "commit") {
		return "You are a fast git commit assistant. Inspect repo changes and recent commit history, infer the local commit style, make a single coherent commit when appropriate, and report the result clearly.";
	}
	return "You are a focused coding subagent. Complete the task accurately and concisely.";
}

function getToolList(cwd: string, tools: SubagentSpec["tools"]) {
	if (tools === "readonly" || tools === undefined) {
		return [
			createReadTool(cwd),
			createBashTool(cwd),
			createGrepTool(cwd),
			createFindTool(cwd),
			createLsTool(cwd),
		];
	}
	if (tools === "full") {
		return [
			createReadTool(cwd),
			createBashTool(cwd),
			createGrepTool(cwd),
			createFindTool(cwd),
			createLsTool(cwd),
			createEditTool(cwd),
			createWriteTool(cwd),
		];
	}
	const builtIns = {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};
	return tools.flatMap((name) => (name in builtIns ? [builtIns[name as keyof typeof builtIns]] : []));
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
		: resolveSubagentModel(config, spec.role, spec.planSubRole);
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

	const systemPrompt = defaultPromptFor(spec);
	const taskText = [spec.context?.trim(), spec.task.trim()].filter(Boolean).join("\n\n");
	const resourceLoader = createResourceLoader(systemPrompt);

	try {
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			model: modelForSession,
			thinkingLevel: (spec.thinkingLevel as any) ?? resolved?.thinkingLevel ?? getCurrentThinkingLevel(ctx) ?? "medium",
			tools: getToolList(ctx.cwd, spec.tools),
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: ctx.modelRegistry,
		});

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
