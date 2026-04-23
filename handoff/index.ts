import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";
import { isToolDisabledInActiveMode } from "../pa/shared/mode.js";
import type { SubagentCoreAPI } from "../subagents/types.js";

type HandoffMode = "default" | "plan";

function getBranchMessages(ctx: ExtensionContext) {
	return ctx.sessionManager.getBranch()
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
}

function inferMode(goal: string): HandoffMode {
	return /\b(make|create|write|draft)\s+(a\s+)?plan\b|\bplan\s+for\b|\bplanning\b/i.test(goal) ? "plan" : "default";
}

async function generateHandoffPrompt(
	core: SubagentCoreAPI,
	ctx: ExtensionContext,
	goal: string,
	mode: HandoffMode | undefined,
	model: string | undefined,
) {
	const config = await loadConfig(ctx.cwd);
	const conversationText = serializeConversation(convertToLlm(getBranchMessages(ctx)));
	return core.runSubagent(ctx, config, {
		role: "handoff",
		label: "handoff",
		task: `## Conversation History\n\n${conversationText}\n\n## Goal for new thread\n\n${goal}`,
		tools: [],
		model,
		context: mode ? `Preferred mode for new thread: ${mode}` : undefined,
		timeout: 180000,
	});
}

function buildFinalPrompt(goal: string, generated: string, parentSession: string | undefined): string {
	return [
		goal.trim(),
		parentSession
			? `If you need details from the previous thread, use the session_query tool.\n\n**Parent session:** \`${parentSession}\``
			: undefined,
		generated.trim(),
	].filter(Boolean).join("\n\n");
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	let pendingToolHandoff: { prompt: string; goal: string; mode: HandoffMode } | null = null;
	let handoffTimestamp: number | null = null;

	pi.events.on("magpie:subagent-core:register", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});
	pi.events.emit("magpie:subagent-core:get", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});

	const performCommandHandoff = async (
		ctx: ExtensionCommandContext,
		goal: string,
		mode: HandoffMode,
		model?: string,
	) => {
		if (!subagentCore) {
			ctx.ui.notify("Subagent core unavailable.", "error");
			return;
		}

		const widgetKey = `magpie-handoff-${Date.now()}`;
		const preview = goal.split("\n")[0].slice(0, 60);
		ctx.ui.setWidget(widgetKey, [`Generating handoff for: ${preview}`], { placement: "aboveEditor" });

		let generated: Awaited<ReturnType<typeof generateHandoffPrompt>>;
		try {
			generated = await generateHandoffPrompt(subagentCore, ctx, goal, mode, model);
		} finally {
			ctx.ui.setWidget(widgetKey, undefined);
		}

		if (generated.exitCode !== 0) {
			ctx.ui.notify(generated.errorMessage ?? "Failed to generate handoff prompt.", "error");
			return;
		}
		const parentSession = ctx.sessionManager.getSessionFile();
		const draft = buildFinalPrompt(goal, generated.output, parentSession);
		const edited = await ctx.ui.editor("Edit handoff prompt", draft);
		if (edited === undefined) return;
		const result = await ctx.newSession({ parentSession });
		if (result.cancelled) return;
		if (mode === "plan") pi.events.emit("magpie:handoff:set-mode", { mode: "plan" });
		else pi.events.emit("magpie:handoff:set-mode", { mode: "default" });
		ctx.ui.setEditorText(edited);
		ctx.ui.notify("Handoff ready. Submit when ready.", "info");
	};

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingToolHandoff) return;
		const pending = pendingToolHandoff;
		pendingToolHandoff = null;
		const sessionManager = ctx.sessionManager as any;
		if (typeof sessionManager.newSession !== "function") {
			ctx.ui.notify("Automatic handoff session switch unavailable.", "warning");
			return;
		}
		handoffTimestamp = Date.now();
		sessionManager.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
		setTimeout(() => {
			pi.events.emit("magpie:handoff:set-mode", { mode: pending.mode });
			pi.sendUserMessage(pending.prompt);
		}, 0);
	});

	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;
		return { messages: event.messages.filter((message: { timestamp?: number }) => (message.timestamp ?? 0) >= handoffTimestamp!) };
	});

	pi.on("session_start", () => {
		handoffTimestamp = null;
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <plan|default>, -model <provider/id>)",
		handler: async (args, ctx) => {
			const config = await loadConfig(ctx.cwd);
			if (isToolDisabledInActiveMode(ctx, config, "handoff")) {
				ctx.ui.notify("Handoff is disabled in the current mode. Switch modes if you want coding workflow tools.", "warning");
				return;
			}
			const raw = args?.trim() ?? "";
			const modeMatch = raw.match(/(?:^|\s)-mode\s+(\S+)/);
			const modelMatch = raw.match(/(?:^|\s)-model\s+(\S+)/);
			const mode = (modeMatch?.[1] === "plan" ? "plan" : modeMatch?.[1] === "default" ? "default" : undefined) ?? inferMode(raw);
			const model = modelMatch?.[1];
			const goal = raw.replace(modeMatch?.[0] ?? "", " ").replace(modelMatch?.[0] ?? "", " ").trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff [-mode <plan|default>] [-model <provider/id>] <goal>", "error");
				return;
			}
			await performCommandHandoff(ctx, goal, mode, model);
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description: "Transfer context to a new focused session. Use when the user explicitly asks to handoff or continue in a new thread.",
		promptSnippet: "Use this to start a new thread with transferred context when the user asks for handoff.",
		promptGuidelines: [
			"handoff: Use this when the user clearly asks for a handoff/new thread continuation.",
			"handoff: Provide a concrete goal and include optional mode/model only when needed.",
			"handoff: If user says 'make a plan', prefer mode='plan' (or let auto mode infer it).",
			"handoff: Do not call this if the user already typed /handoff.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "Goal for the new thread" }),
			mode: Type.Optional(StringEnum(["auto", "default", "plan"] as const)),
			model: Type.Optional(Type.String({ description: "Optional model override (provider/model-id)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "handoff requires interactive mode." }], details: {}, isError: true };
			if (!subagentCore) return { content: [{ type: "text", text: "Subagent core unavailable." }], details: {}, isError: true };
			const goal = params.goal.trim();
			if (!goal) return { content: [{ type: "text", text: "Missing goal." }], details: {}, isError: true };
			const mode = params.mode && params.mode !== "auto" ? (params.mode as HandoffMode) : inferMode(goal);
			const generated = await generateHandoffPrompt(subagentCore, ctx, goal, mode, params.model?.trim());
			if (generated.exitCode !== 0) {
				return { content: [{ type: "text", text: generated.errorMessage ?? "Failed to generate handoff prompt." }], details: { result: generated }, isError: true };
			}
			const draft = buildFinalPrompt(goal, generated.output, ctx.sessionManager.getSessionFile());
			const edited = await ctx.ui.editor("Edit handoff prompt", draft);
			if (edited === undefined) return { content: [{ type: "text", text: "Handoff cancelled." }], details: {} };
			pendingToolHandoff = { prompt: edited, goal, mode };
			return { content: [{ type: "text", text: `Handoff initiated (mode: ${mode}). It will switch session after this turn.` }], details: { mode } };
		},
	});
}
