import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, createBashTool, createEditTool, createReadTool, createWriteTool, serializeConversation } from "@mariozechner/pi-coding-agent";

import { buildBtwModeDirective, resolveBtwModeSelection } from "./lib/mode-utils.js";
import {
	type SingleResult,
	btwTaskPreview,
	renderBtwResult,
	renderProgressPlainLines,
	runSubagent,
} from "./lib/subagent-core.js";

const BTW_MESSAGE_TYPE = "btw-result";

interface BtwMessageDetails {
	task: string;
	result: SingleResult;
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

type RuntimeModel = NonNullable<ExtensionContext["model"]>;

function getModelKey(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function addModelCandidate(
	candidates: RuntimeModel[],
	model: RuntimeModel | undefined,
): void {
	if (!model) return;
	if (candidates.some((candidate) => getModelKey(candidate) === getModelKey(model))) return;
	candidates.push(model);
}

async function resolveTargetModel(
	ctx: ExtensionContext,
	selection: Awaited<ReturnType<typeof resolveBtwModeSelection>>,
	modelRefOverride: string | undefined,
): Promise<{ model: RuntimeModel; apiKey: string; headers?: Record<string, string> } | undefined> {
	const candidates: RuntimeModel[] = [];
	const overrideModel = modelRefOverride ? parseModelRef(modelRefOverride) : undefined;
	if (modelRefOverride && !overrideModel) {
		throw new Error(`Invalid model ref: ${modelRefOverride} (expected provider/modelId)`);
	}
	if (overrideModel) {
		addModelCandidate(candidates, ctx.modelRegistry.find(overrideModel.provider, overrideModel.modelId) as RuntimeModel | undefined);
	}
	if (selection.modelRef) {
		const parsed = parseModelRef(selection.modelRef);
		if (parsed) addModelCandidate(candidates, ctx.modelRegistry.find(parsed.provider, parsed.modelId) as RuntimeModel | undefined);
	}
	addModelCandidate(candidates, ctx.model as RuntimeModel | undefined);

	for (const candidate of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
		if (auth.ok && auth.apiKey) {
			return { model: candidate, apiKey: auth.apiKey, headers: auth.headers };
		}
	}

	return undefined;
}

function buildSubagentSystemPrompt(baseSystemPrompt: string, modeName: string): string {
	return [
		baseSystemPrompt.trim(),
		"",
		"You are running as a background /btw subagent.",
		"The btw-specific mode instructions below override any outer session mode guidance.",
		buildBtwModeDirective(modeName),
		"Do not hand off or spawn further subagents.",
	].join("\n").trim();
}

export default function btwExtension(pi: ExtensionAPI): void {
	const pendingWidgetRemovals = new Map<string, () => void>();
	let btwCounter = 0;

	pi.on("turn_end", () => {
		for (const [, resolve] of pendingWidgetRemovals) resolve();
		pendingWidgetRemovals.clear();
	});

	pi.on("context", (event) => {
		const filtered = event.messages.filter((m: any) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE));
		if (filtered.length !== event.messages.length) return { messages: filtered };
	});

	pi.registerMessageRenderer<BtwMessageDetails>(BTW_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		return renderBtwResult(details.result, theme);
	});

	pi.registerCommand("btw", {
		description: "Run a single background subagent (-mode <name>, -model <provider/modelId>; defaults to rush)",
		handler: async (args, ctx) => {
			let remaining = args ?? "";
			let modeOpt: string | undefined;
			let modelOpt: string | undefined;

			const modeMatch = remaining.match(/(?:^|\s)-{1,2}mode\s+(\S+)/);
			if (modeMatch) {
				modeOpt = modeMatch[1];
				remaining = remaining.replace(modeMatch[0], " ");
			}

			const modelMatch = remaining.match(/(?:^|\s)-{1,2}model\s+(\S+)/);
			if (modelMatch) {
				modelOpt = modelMatch[1];
				remaining = remaining.replace(modelMatch[0], " ");
			}

			const task = remaining.trim();
			if (!task) {
				ctx.ui.notify("Usage: /btw [-mode <name>] [-model <provider/modelId>] <prompt>", "error");
				return;
			}

			let selection;
			try {
				selection = await resolveBtwModeSelection(ctx.cwd, modeOpt);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			let resolved;
			try {
				resolved = await resolveTargetModel(ctx, selection, modelOpt);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!resolved) {
				ctx.ui.notify("No model available for btw.", "error");
				return;
			}

			const systemPrompt = buildSubagentSystemPrompt(ctx.getSystemPrompt(), selection.modeName);
			const tools = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message)
				.filter((message: any) => !message?.customType);
			const conversationContext = messages.length > 0
				? serializeConversation(convertToLlm(messages))
				: "";

			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task or question (FOCUS SOLELY ON THIS)\n\n${task}`
				: task;

			const widgetKey = `btw-${++btwCounter}`;
			const taskPreview = btwTaskPreview(task);
			if (ctx.hasUI) {
				ctx.ui.setWidget(widgetKey, [`⏳ btw: ${taskPreview}`], { placement: "aboveEditor" });
			}

			const subagentScope = runSubagent(
				systemPrompt,
				taskWithContext,
				tools,
				resolved.model,
				selection.thinkingLevel ?? ctx.getThinkingLevel(),
				resolved.apiKey,
				resolved.headers,
				undefined,
				(progressResult) => {
					if (!ctx.hasUI) return;
					ctx.ui.setWidget(widgetKey, renderProgressPlainLines(task, progressResult), { placement: "aboveEditor" });
				},
			);

			const handleResult = async (result: SingleResult) => {
				result.task = task;

				const icon = result.exitCode === 0 ? "✓" : "✗";
				pi.sendMessage({
					customType: BTW_MESSAGE_TYPE,
					content: [{ type: "text", text: `[btw ${icon}] ${task}` }],
					display: true,
					details: { task, result } satisfies BtwMessageDetails,
				}, { triggerTurn: false });

				if (ctx.hasUI && !ctx.isIdle()) {
					ctx.ui.setWidget(widgetKey, (_tui, theme) => renderBtwResult(result, theme), { placement: "aboveEditor" });
					await new Promise<void>((resolve) => {
						pendingWidgetRemovals.set(widgetKey, resolve);
					});
				}
				if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
			};

			void subagentScope
				.then((result) => {
					void handleResult(result).catch((err) => {
						if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
						ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					});
				})
				.catch((err) => {
					if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
					ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
		},
	});
}
