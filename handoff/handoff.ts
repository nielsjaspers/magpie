/**
 * Handoff extension - transfer context to a new focused session
 *
 * Supports:
 * - /handoff command
 * - handoff tool (agent-callable)
 *
 * Notes:
 * - Command path uses ctx.newSession() (full runtime session switch).
 * - Tool path cannot call ctx.newSession(), so it defers a low-level
 *   session switch to agent_end, then sends the generated prompt.
 * - Tool-path coordination and parent-session metadata pattern are
 *   inspired by pi-amplike.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SYSTEM_PROMPT = `You are a context transfer assistant. Your job is to read a full conversation history and a user-specified goal, then produce a single, self-contained prompt that a fresh agent session can use to continue the work without access to the original conversation.

This is not summarization. You are not compressing the conversation. You are extracting and restructuring the information that is relevant to the user's stated goal for the next session, and discarding everything else. The new session will have zero memory of the old one. Your output is the only bridge between them.

## How to analyze the conversation

Read the full conversation and identify:

1. **The current state of the work.** What has been built, changed, fixed, or decided? What is the codebase like right now as a result of this conversation? Focus on outcomes, not process. The new session does not need to know about false starts, reverted approaches, or debugging rabbit holes unless they contain lessons that prevent repeating mistakes.

2. **Decisions and rationale.** What design decisions were made, and why? If the user or agent rejected an approach, note what was rejected and the reason. These are critical because without them, the new session will likely re-propose the rejected approach and waste time.

3. **Files that were touched or discussed.** List every file that was created, modified, read, or referenced in a meaningful way. Include file paths exactly as they appeared. For modified files, briefly note what was changed and why. For files that were only read for reference, note what information was extracted from them.

4. **Patterns, conventions, and constraints discovered.** If the conversation revealed project conventions (naming patterns, architectural patterns, test strategies, API styles, error handling approaches), capture those. The new session needs to follow the same conventions.

5. **Known issues, edge cases, and unfinished threads.** If bugs were found but not fixed, if edge cases were identified but deferred, if TODOs were noted, capture them, but only if they are relevant to the stated goal.

6. **Technical context.** Language, framework, build system, test runner, relevant dependencies and their versions, environment details. Anything the new session would otherwise have to discover by reading files.

## How to handle different goal types

The user's goal for the new thread determines what context is relevant. Apply judgment:

- If the goal is to **continue or extend** the current work (e.g., "now implement this for teams as well"), include thorough context about the existing implementation: architecture, data flow, patterns used, files involved. The new session needs to understand what exists before it can extend it.

- If the goal is to **execute a plan** that was discussed (e.g., "execute phase one of the plan"), reproduce the relevant parts of the plan in full. Do not summarize the plan. Plans contain specific steps and details that get lost in summarization. Include any modifications or refinements that were discussed after the plan was initially proposed.

- If the goal is to **apply a fix or pattern broadly** (e.g., "check the rest of the codebase for this same issue"), clearly describe the issue, the fix that was applied, the before/after pattern so the new session can recognize similar cases, and any nuances or variations that were discovered.

- If the goal is to **review or test** previous work (e.g., "write tests for what we just built"), include the full interface and behavior contract of what was built, not just file names. The new session needs to understand expected behavior, edge cases, and error conditions.

- If the goal is to **start a loosely related task** where only some context carries over, be aggressive about trimming. Only include what the new task actually needs. Do not dump the entire conversation's context into the prompt out of caution.

## Output format

Structure your output as a prompt that reads naturally, as if a knowledgeable developer wrote it to brief a colleague. Use this structure:

### Context
Summarize the state of things: what exists, what was built, what decisions were made and why. Write in prose, not as a mechanical list of facts. Group related information together. This section should give the new session a mental model of the current state of the project as it relates to the goal.

### Files
List the files that are relevant to the new task. For each file, include a brief note about its role or what was changed in it. Only include files the new session will likely need to read or modify. Do not include files that were only tangentially mentioned.

### Constraints and conventions
If the conversation established patterns, constraints, or conventions the new session must follow, state them clearly. Examples: "All API endpoints follow the pattern X," "Error handling uses Result types, not exceptions," "Tests use vitest with the following helpers." Skip this section if no meaningful constraints were identified.

### Known issues
If there are known bugs, edge cases, incomplete work, or gotchas that are relevant to the goal, list them. Skip this section if there are none.

### Task
State the goal clearly and specifically. Expand on the user's terse goal description using context from the conversation. If the user said "now implement this for teams," your task description should specify what "this" refers to and what "for teams" means concretely based on the conversation. Break down the task into concrete sub-steps if the conversation already explored what needs to happen.

## Rules

- Be specific. Use exact file paths, function names, type names, variable names. Vague references like "the main component" or "the helper function" are useless without the original context.
- Preserve code snippets only when they are essential to understanding a pattern, interface, or constraint. Do not paste large blocks of code that the new session can read from the filesystem.
- Do not editorialize. Do not add your own suggestions or opinions about how to proceed. Your job is to transfer context, not to do the work.
- Do not include conversational artifacts like "the user asked about X and the assistant explained Y." Write as direct statements of fact: "X works by doing Y."
- Do not include a preamble. Do not say "Here is the handoff prompt." Just output the prompt itself, starting with the Context section.
- Err on the side of including too much relevant context rather than too little. The new session can skim, but it cannot recover information you omitted.
- If the conversation contains disagreements or unresolved debates relevant to the goal, present them fairly. Do not silently pick a side.`;

interface HandoffModeModels {
	default?: string;
	plan?: string;
}

interface HandoffConfig {
	model?: string;
	modeModels?: HandoffModeModels;
}

type HandoffMode = "default" | "plan";
type RuntimeModel = NonNullable<ExtensionContext["model"]>;

type HandoffOptions = {
	mode?: HandoffMode;
	model?: string;
};

function getProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi/handoff.json");
}

function getGlobalConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "handoff.json");
}

async function readHandoffConfig(path: string): Promise<HandoffConfig | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as {
			model?: unknown;
			modeModels?: { default?: unknown; plan?: unknown };
		};

		const model = typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model.trim() : undefined;
		const modeModels: HandoffModeModels = {
			default:
				typeof parsed.modeModels?.default === "string" && parsed.modeModels.default.trim().length > 0
					? parsed.modeModels.default.trim()
					: undefined,
			plan:
				typeof parsed.modeModels?.plan === "string" && parsed.modeModels.plan.trim().length > 0
					? parsed.modeModels.plan.trim()
					: undefined,
		};

		return {
			model,
			modeModels: modeModels.default || modeModels.plan ? modeModels : undefined,
		};
	} catch {
		return undefined;
	}
}

async function loadEffectiveConfig(cwd: string): Promise<HandoffConfig> {
	const globalConfig = await readHandoffConfig(getGlobalConfigPath());
	const projectConfig = await readHandoffConfig(getProjectConfigPath(cwd));

	return {
		model: projectConfig?.model ?? globalConfig?.model,
		modeModels: {
			default: projectConfig?.modeModels?.default ?? globalConfig?.modeModels?.default,
			plan: projectConfig?.modeModels?.plan ?? globalConfig?.modeModels?.plan,
		},
	};
}

function inferMode(goal: string): HandoffMode {
	const text = goal.toLowerCase();
	if (
		/\b(make|create|write|draft)\s+(a\s+)?plan\b/.test(text) ||
		/\bplan\s+for\b/.test(text) ||
		/\bplanning\b/.test(text)
	) {
		return "plan";
	}
	return "default";
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const trimmed = ref.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

function getModelKey(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function addModelCandidate(candidates: RuntimeModel[], model: RuntimeModel | undefined): void {
	if (!model) return;
	const key = getModelKey(model);
	if (candidates.some((candidate) => getModelKey(candidate) === key)) return;
	candidates.push(model);
}

function resolveModelByRef(ctx: ExtensionContext, modelRef: string | undefined): RuntimeModel | undefined {
	if (!modelRef) return undefined;
	const parsed = parseModelRef(modelRef);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.modelId) as RuntimeModel | undefined;
}

function getModeModelRef(config: HandoffConfig, mode: HandoffMode | undefined): string | undefined {
	if (!mode) return undefined;
	return mode === "plan" ? config.modeModels?.plan : config.modeModels?.default;
}

async function resolveHandoffModelAndAuth(
	ctx: ExtensionContext,
	config: HandoffConfig,
	options?: HandoffOptions,
): Promise<{ model: RuntimeModel; apiKey: string; headers?: Record<string, string> } | undefined> {
	const candidates: RuntimeModel[] = [];

	addModelCandidate(candidates, resolveModelByRef(ctx, options?.model));
	addModelCandidate(candidates, resolveModelByRef(ctx, getModeModelRef(config, options?.mode)));
	addModelCandidate(candidates, resolveModelByRef(ctx, config.model));
	addModelCandidate(candidates, ctx.model as RuntimeModel | undefined);

	for (const candidate of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
		if (auth.ok && auth.apiKey) {
			return {
				model: candidate,
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}

	return undefined;
}

function getBranchMessages(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	return branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
}

async function generateHandoffPrompt(
	ctx: ExtensionContext,
	goal: string,
	options?: HandoffOptions,
): Promise<{ prompt: string; options: HandoffOptions } | null> {
	if (!ctx.hasUI) return null;

	const messages = getBranchMessages(ctx);
	if (messages.length === 0) return null;

	const config = await loadEffectiveConfig(ctx.cwd);
	const effectiveMode = options?.mode ?? inferMode(goal);
	const effectiveOptions: HandoffOptions = {
		mode: effectiveMode,
		model: options?.model,
	};

	const resolved = await resolveHandoffModelAndAuth(ctx, config, effectiveOptions);
	if (!resolved) return null;

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done?.(null);

		const doGenerate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				resolved.model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: resolved.apiKey, headers: resolved.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") return null;

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			return text.length > 0 ? text : null;
		};

		doGenerate()
			.then(done)
			.catch((error) => {
				console.error("Handoff generation failed:", error);
				done?.(null);
			});

		return loader;
	});

	if (result === null) return null;
	return { prompt: result, options: effectiveOptions };
}

function buildFinalHandoffPrompt(goal: string, generatedPrompt: string, parentSession: string | undefined): string {
	const sections: string[] = [];
	const trimmedGoal = goal.trim();
	if (trimmedGoal.length > 0) {
		sections.push(trimmedGoal);
	}

	if (parentSession) {
		sections.push(
			`If you need details from the previous thread, use the session_query tool.\n\n**Parent session:** \`${parentSession}\``,
		);
	}

	const trimmedGenerated = generatedPrompt.trim();
	if (trimmedGenerated.length > 0) {
		sections.push(trimmedGenerated);
	}

	return sections.join("\n\n");
}

async function applyPostSwitchPreferences(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: HandoffOptions | undefined,
): Promise<void> {
	if (!options) return;

	const config = await loadEffectiveConfig(ctx.cwd);
	const targetModelRef = options.model ?? getModeModelRef(config, options.mode);
	const targetModel = resolveModelByRef(ctx, targetModelRef);
	if (targetModel) {
		await pi.setModel(targetModel);
	}

	if (options.mode === "plan") {
		pi.events.emit("magpie:handoff:set-mode", { mode: "plan" });
	} else if (options.mode === "default") {
		pi.events.emit("magpie:handoff:set-mode", { mode: "default" });
	}
}

function parseArgsWithOptions(args: string): { goal: string; options: HandoffOptions } {
	const options: HandoffOptions = {};
	let remaining = args;

	const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
	if (modeMatch) {
		const modeRaw = modeMatch[1]?.trim().toLowerCase();
		if (modeRaw === "plan") options.mode = "plan";
		if (modeRaw === "default") options.mode = "default";
		remaining = remaining.replace(modeMatch[0], " ");
	}

	const modelMatch = remaining.match(/(?:^|\s)-model\s+(\S+)/);
	if (modelMatch) {
		options.model = modelMatch[1]?.trim();
		remaining = remaining.replace(modelMatch[0], " ");
	}

	return {
		goal: remaining.trim(),
		options,
	};
}

export default function (pi: ExtensionAPI) {
	let pendingToolHandoff:
		| {
				goal: string;
				prompt: string;
				parentSession: string | undefined;
				options?: HandoffOptions;
		  }
		| null = null;
	let handoffTimestamp: number | null = null;

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingToolHandoff) return;
		const pending = pendingToolHandoff;
		pendingToolHandoff = null;

		const sessionManager = ctx.sessionManager as unknown as {
			newSession?: (options?: { parentSession?: string }) => string | undefined;
		};

		if (typeof sessionManager.newSession !== "function") {
			ctx.ui.notify(
				"Automatic handoff session switch is unavailable in this runtime. Prepared /handoff command in editor as fallback.",
				"warning",
			);
			ctx.ui.setEditorText(`/handoff ${pending.goal}`);
			return;
		}

		handoffTimestamp = Date.now();
		sessionManager.newSession({ parentSession: pending.parentSession });

		setTimeout(async () => {
			await applyPostSwitchPreferences(pi, ctx, pending.options);
			pi.sendUserMessage(pending.prompt);
		}, 0);
	});

	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;
		const filtered = event.messages.filter((m: { timestamp?: number }) => (m.timestamp ?? 0) >= handoffTimestamp);
		if (filtered.length > 0) return { messages: filtered };
	});

	pi.on("session_start", () => {
		handoffTimestamp = null;
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <plan|default>, -model <provider/id>)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			const parsed = parseArgsWithOptions(args);
			if (!parsed.goal) {
				ctx.ui.notify("Usage: /handoff [-mode <plan|default>] [-model <provider/id>] <goal>", "error");
				return;
			}

			const messages = getBranchMessages(ctx);
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const generated = await generateHandoffPrompt(ctx, parsed.goal, parsed.options);
			if (!generated) {
				ctx.ui.notify(
					"Unable to generate handoff prompt. Check model selection/config and try again.",
					"error",
				);
				return;
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			const handoffDraft = buildFinalHandoffPrompt(parsed.goal, generated.prompt, parentSession);
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", handoffDraft);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({ parentSession });
			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			await applyPostSwitchPreferences(pi, ctx, generated.options);
			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. Use when the user explicitly asks to handoff or continue in a new thread.",
		promptSnippet: "Use this to start a new thread with transferred context when the user asks for handoff.",
		promptGuidelines: [
			"Use this when the user clearly asks for a handoff/new thread continuation.",
			"Provide a concrete goal and include optional mode/model only when needed.",
			"If user says 'make a plan', prefer mode='plan' (or let auto mode infer it).",
			"Do not call this if the user already typed /handoff.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "Goal for the new thread" }),
			mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("default"), Type.Literal("plan")])),
			model: Type.Optional(Type.String({ description: "Optional model override (provider/model-id)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "handoff requires interactive mode." }], isError: true };
			}

			const goal = params.goal.trim();
			if (!goal) {
				return { content: [{ type: "text", text: "Missing goal." }], isError: true };
			}

			const explicitMode = params.mode && params.mode !== "auto" ? (params.mode as HandoffMode) : undefined;
			const options: HandoffOptions = {
				mode: explicitMode,
				model: params.model?.trim() || undefined,
			};

			const generated = await generateHandoffPrompt(ctx, goal, options);
			if (!generated) {
				return {
					content: [{ type: "text", text: "Failed to generate handoff prompt. Check model selection/config." }],
					isError: true,
				};
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			const handoffDraft = buildFinalHandoffPrompt(goal, generated.prompt, parentSession);
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", handoffDraft);
			if (editedPrompt === undefined) {
				return {
					content: [{ type: "text", text: "Handoff cancelled." }],
				};
			}

			pendingToolHandoff = {
				goal,
				prompt: editedPrompt,
				parentSession,
				options: generated.options,
			};

			return {
				content: [
					{
						type: "text",
						text: `Handoff initiated (mode: ${generated.options.mode ?? "default"}). It will switch session and continue after this turn.`,
					},
				],
			};
		},
	});
}
