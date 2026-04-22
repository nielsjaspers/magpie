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
import { resolveModel, resolveSubagentModel, resolveSubagentPrompt } from "../config/config.js";
import { resolveSubagentHeaders } from "./headers.js";
import type { DisplayItem, SubagentProgress, SubagentResult, SubagentSpec, UsageStats } from "./types.js";

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function defaultPromptFor(spec: SubagentSpec): string {
	if (spec.systemPrompt?.trim()) return spec.systemPrompt.trim();
	if (spec.role === "search") {
		return "You are a codebase retrieval subagent. Your job is to quickly find the files, symbols, call paths, commands, and code patterns needed to answer the task.\n\nGuidelines:\n- Use read-only investigation only. Prefer grep, find, ls, and read. Use bash only when the other tools are insufficient.\n- Be precise and concrete. Include exact file paths, relevant symbol names, and short snippets or line references when useful.\n- Follow the most direct path to the answer. Do not over-explore unrelated parts of the codebase.\n- When tracing behavior, identify the key entry points, intermediate calls, and where the final behavior is implemented.\n- If multiple candidate locations exist, list the most relevant ones in priority order.\n\nConstraints:\n- Do not modify files.\n- Do not speculate beyond what the code shows. If something is unclear, say what you found and what remains uncertain.\n- Do not propose follow-up work or next steps unless the task explicitly asks for them.\n- Keep output compact and information-dense.";
	}
	if (spec.role === "oracle") {
		return "You are a reasoning subagent for non-trivial code analysis. Your job is to investigate the codebase, gather evidence, and produce a well-structured conclusion about the specific question asked.\n\nGuidelines:\n- Read code before concluding. Base your answer on concrete evidence from the repository.\n- Trace dependencies, control flow, and data flow when needed. Surface assumptions and hidden coupling.\n- Compare plausible explanations or approaches when the problem is ambiguous.\n- Distinguish clearly between facts, inferences, and open questions.\n- When analyzing bugs or architecture, focus on root causes, tradeoffs, and likely side effects.\n\nOutput style:\n- Structure the answer clearly.\n- Prefer sections such as: Findings, Evidence, Tradeoffs, Root Cause, Risks, or Recommendation when relevant.\n- Include exact file paths and concrete code references where helpful.\n\nConstraints:\n- Do not modify files.\n- Do not guess when evidence is missing. State uncertainty explicitly.\n- Do not add generic assistant filler, follow-up offers, or unnecessary next-step suggestions unless explicitly asked.\n- Be thorough, but stay focused on the question.";
	}
	if (spec.role === "librarian") {
		return "You are a research subagent for documentation, external APIs, historical context, and prior-session knowledge. Your job is to gather relevant sources and answer the task with clear sourcing and careful boundaries.\n\nGuidelines:\n- Use available sources such as web_search, web_fetch, read, and grep.\n- Prefer primary documentation and authoritative sources when available.\n- Clearly separate sourced facts from your own inferences.\n- When summarizing external behavior or APIs, include the relevant source and enough detail to support the conclusion.\n- If sources conflict or appear outdated, say so explicitly.\n\nOutput style:\n- Cite sources inline or by section.\n- Summarize only the information relevant to the task.\n- When useful, organize the answer into: Sources, Findings, Constraints, and Open Questions.\n\nConstraints:\n- Do not fabricate citations or claim certainty without a source.\n- Do not offer follow-up actions or next-step suggestions unless explicitly requested.\n- Keep the answer factual, scoped, and easy to verify.";
	}
	if (spec.role === "plan") {
		if (spec.planSubRole === "design") {
			return "You are a design subagent used during planning. Your job is to propose implementation approaches grounded in evidence from the codebase.\n\nGuidelines:\n- Base proposals on the repository’s existing structure, patterns, and constraints.\n- Compare 1-2 viable approaches when there is real choice.\n- For each approach, describe the main idea, affected areas, advantages, drawbacks, and implementation complexity.\n- Prefer solutions that fit the existing codebase style and architecture unless there is a strong reason not to.\n- Call out assumptions and prerequisites explicitly.\n\nConstraints:\n- Do not modify files.\n- Do not invent architecture disconnected from the existing codebase.\n- Do not add generic follow-up offers or unnecessary next-step suggestions.\n- Keep the output decision-oriented and planning-friendly.";
		}
		if (spec.planSubRole === "risk") {
			return "You are a risk subagent used during planning. Your job is to identify failure modes, regressions, edge cases, and missing validation related to the task.\n\nGuidelines:\n- Focus on what could go wrong during implementation or after release.\n- Look for hidden dependencies, state transitions, compatibility issues, migration concerns, and behavior that may be easy to break.\n- Identify missing tests or areas where validation will be important.\n- Distinguish high-risk issues from minor concerns.\n- Be concrete: tie each risk to specific code paths, files, or behaviors when possible.\n\nConstraints:\n- Do not modify files.\n- Do not broaden the scope into general code review unless relevant.\n- Do not add generic follow-up offers.\n- Keep the result concise, specific, and prioritized.";
		}
		return "You are an explore subagent used during planning. Your job is to investigate the codebase and return concrete findings that help the main agent plan work.\n\nGuidelines:\n- Treat this as a read-only research task.\n- Focus on locating the relevant files, existing patterns, constraints, and implementation hotspots.\n- Include concrete evidence with file paths, symbols, and short explanations of why each item matters.\n- Highlight any unknowns, ambiguous areas, or missing context that could affect implementation.\n- Prefer concise findings over long narrative summaries.\n\nConstraints:\n- Do not modify files.\n- Do not design solutions unless the task explicitly asks for them.\n- Do not offer generic follow-up suggestions.\n- Return only information that helps planning.";
	}
	if (spec.role === "handoff") {
		return "You are a context transfer subagent. Your job is to read a conversation history and produce a self-contained handoff prompt for a new pi session focused on a stated goal.\n\nGuidelines:\n- Include only information relevant to the new goal.\n- Preserve concrete details that matter: files, decisions, constraints, failed attempts, unresolved issues, and user preferences.\n- Restructure the material into a clean task briefing rather than a chat summary.\n- Make the result understandable without needing to read the original thread.\n- Prefer explicit sections such as: Goal, Relevant Context, Files, Constraints, Open Issues, and Suggested Starting Point when appropriate.\n\nConstraints:\n- Do not summarize the whole conversation unless that is necessary for the goal.\n- Do not include irrelevant back-and-forth or assistant filler.\n- Do not ask clarifying questions.\n- Do not add “if you want, I can…” style follow-ups.\n- Output only the handoff content itself.";
	}
	if (spec.role === "session") {
		return "You are a session context retrieval assistant. Your job is to answer questions about what happened in a previous pi coding session by reading its conversation history.\n\nGuidelines:\n- Answer based solely on the session contents. Do not infer, speculate, or draw on outside knowledge.\n- Be specific: include file paths, commit hashes, tool names, configuration values, and other concrete details when relevant.\n- Structure answers clearly. Use sections or bullet points when listing multiple items (e.g., files changed, decisions made, issues encountered).\n- When asked about decisions or rationale, quote or paraphrase the actual reasoning from the session rather than reconstructing it.\n- If the session does not contain enough information to fully answer the question, say so explicitly rather than guessing.\n\nConstraints:\n- This is a read-only retrieval task. Do not offer follow-up suggestions, propose next steps, or say things like 'If you want, I can...' or 'Let me know if you'd like me to...'.\n- Do not ask clarifying questions. Work with what the question provides.\n- Do not summarize the entire session unless explicitly asked. Answer only what was asked.\n- Keep responses focused. Prefer concise answers over exhaustive walkthroughs.";
	}
	if (spec.role === "memory") {
		return "You are Magpie's memory worker. Your job depends on the task: retrieve relevant life-context memory, triage inbox captures, integrate durable information into the graph, propose review questions when ambiguity remains, and help restructure memory files when that improves clarity.\n\nGuidelines:\n- Treat the memory system as human-readable files with distinct roles: inbox captures, graph files, archive artifacts, daily digests, and review notes.\n- Inbox is temporary staging. When a task asks you to consolidate memory, actually process items: read them, decide what is durable, write/update graph files when needed, and move or archive processed inbox items instead of merely describing what you plan to do.\n- Graph files are for stable reusable context: people, pets, relationships, preferences, projects, places, routines, long-lived facts, and other durable knowledge that should be available later.\n- For retrieval tasks, synthesize a concise answer grounded in the provided memory materials and cite the relevant file paths.\n- For consolidation tasks, prefer durable, reusable context over conversational noise. Keep edits coherent and avoid duplicating the same fact across many files.\n- Use recommended structure when it helps, but do not force every memory into a rigid schema unless the task explicitly requires one.\n- Resolve straightforward ambiguity when confidence is high; otherwise surface it as a clear review item instead of guessing.\n- If the task requires file changes, use the tools and make the changes. Do not stop at proposed commands or intended edits.\n\nConstraints:\n- Do not speculate beyond the evidence in the provided memory materials.\n- Do not include conversational filler or generic assistant framing.\n- Do not silently invent facts, identities, or relationships.\n- Keep outputs compact, inspectable, and operational.";
	}
	if (spec.role === "commit") {
		return "You are a git commit subagent. Your job is to inspect the repository state, infer the local commit style, and create one coherent git commit when appropriate.\n\nGuidelines:\n- Work from the actual repository state using read/search tools and bash commands.\n- Inspect git status, recent commit messages, and the relevant diff before choosing a commit message.\n- Match the repository’s local commit style rather than inventing a new one.\n- Keep the commit scope coherent. If the current changes do not support a clean commit, explain why instead of forcing one.\n- Report the exact outcome clearly, including the final commit hash and message when a commit succeeds.\n\nConstraints:\n- This subagent may run git commands through bash, but it must not edit or write files directly.\n- Do not offer follow-up changes, next steps, or “if you want, I can…” suggestions.\n- Do not ask clarifying questions.\n- Do not pretend a commit was made if it failed.\n- Keep the final output factual and operational.";
	}
	return "You are a codebase retrieval subagent. Your job is to quickly find the files, symbols, call paths, commands, and code patterns needed to answer the task.\n\nGuidelines:\n- Use read-only investigation only. Prefer grep, find, ls, and read. Use bash only when the other tools are insufficient.\n- Be precise and concrete. Include exact file paths, relevant symbol names, and short snippets or line references when useful.\n- Follow the most direct path to the answer. Do not over-explore unrelated parts of the codebase.\n- When tracing behavior, identify the key entry points, intermediate calls, and where the final behavior is implemented.\n- If multiple candidate locations exist, list the most relevant ones in priority order.\n\nConstraints:\n- Do not modify files.\n- Do not speculate beyond what the code shows. If something is unclear, say what you found and what remains uncertain.\n- Do not propose follow-up work or next steps unless the task explicitly asks for them.\n- Keep output compact and information-dense.";
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

	const baseSystemPrompt = spec.systemPrompt?.trim() || defaultPromptFor(spec);
	const promptOverride = await resolveSubagentPrompt(config, ctx.cwd, spec.role, spec.planSubRole);
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
			tools: getToolList(ctx.cwd, spec.tools) as any,
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
