import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, getMarkdownTheme, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { loadConfig, getMode } from "../config/config.js";
import type { SubagentCoreAPI, SubagentResult } from "../subagents/types.js";

const BTW_MESSAGE_TYPE = "magpie:btw-result";

function parseFlags(input: string): { task: string; mode?: string; model?: string } {
	let remaining = input;
	let mode: string | undefined;
	let model: string | undefined;
	const modeMatch = remaining.match(/(?:^|\s)-{1,2}mode\s+(\S+)/);
	if (modeMatch) {
		mode = modeMatch[1];
		remaining = remaining.replace(modeMatch[0], " ");
	}
	const modelMatch = remaining.match(/(?:^|\s)-{1,2}model\s+(\S+)/);
	if (modelMatch) {
		model = modelMatch[1];
		remaining = remaining.replace(modelMatch[0], " ");
	}
	return { task: remaining.trim(), mode, model };
}

function renderProgress(task: string, result: SubagentResult): string[] {
	const preview = task.split("\n")[0];
	const lines = [`⏳ btw: ${preview}`];
	for (const item of result.displayItems.slice(-6)) {
		if (item.type === "toolCall") lines.push(`  → ${item.name}`);
	}
	if (result.output) lines.push(`  ${result.output.split("\n")[0]}`);
	return lines;
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});
	pi.events.emit("magpie:subagent-core:get", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});

	pi.on("context", (event) => {
		return { messages: event.messages.filter((message: any) => !(message.role === "custom" && message.customType === BTW_MESSAGE_TYPE)) };
	});

	pi.registerMessageRenderer<{ task: string; result: SubagentResult }>(BTW_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		const container = new Container();
		container.addChild(new Text(`${theme.bold("btw:")} ${details.task}`, 0, 0));
		for (const item of details.result.displayItems) {
			if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", `→ ${item.name}`), 0, 0));
		}
		if (details.result.output) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(details.result.output, 0, 0, getMarkdownTheme()));
		}
		return container;
	});

	pi.registerCommand("btw", {
		description: "Run a single background subagent (-mode <name>, -model <provider/modelId>; defaults to rush)",
		handler: async (args, ctx) => {
			if (!subagentCore) {
				ctx.ui.notify("Subagent core unavailable.", "error");
				return;
			}
			const { task, mode, model } = parseFlags(args ?? "");
			if (!task) {
				ctx.ui.notify("Usage: /btw [-mode <name>] [-model <provider/modelId>] <prompt>", "error");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const selectedMode = getMode(config, mode ?? "rush") ?? getMode(config, "rush");
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message)
				.filter((message: any) => !message?.customType);
			const conversationContext = messages.length > 0 ? serializeConversation(convertToLlm(messages)) : "";
			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task\n\n${task}`
				: task;
			const widgetKey = `magpie-btw-${Date.now()}`;
			ctx.ui.setWidget(widgetKey, [`⏳ btw: ${task}`], { placement: "aboveEditor" });
			void subagentCore.runSubagent(
				ctx,
				config,
				{
					role: "custom",
					label: `btw:${task.split("\n")[0]}`,
					task: taskWithContext,
					context: [
						"You are running as a background /btw subagent.",
						selectedMode ? `Selected btw mode: ${selectedMode.name}.` : "Selected btw mode: rush.",
						"Do not hand off or spawn further subagents.",
					].join("\n"),
					model: model ?? selectedMode?.model,
					thinkingLevel: selectedMode?.thinkingLevel,
					tools: "full",
				},
				undefined,
				(progress) => {
					ctx.ui.setWidget(widgetKey, renderProgress(task, { spec: { role: "custom", label: "btw", task }, output: progress.partialOutput, displayItems: progress.toolCalls.map((call) => ({ type: "toolCall" as const, name: call.name, args: call.args })), exitCode: -1, usage: progress.usage, model: model ?? selectedMode?.model ?? "", stopReason: undefined }), { placement: "aboveEditor" });
				},
			)
				.then((result) => {
					pi.sendMessage({
						customType: BTW_MESSAGE_TYPE,
						content: [{ type: "text", text: `[btw ${result.exitCode === 0 ? "✓" : "✗"}] ${task}` }],
						display: true,
						details: { task, result },
					}, { triggerTurn: false });
					ctx.ui.setWidget(widgetKey, undefined);
				})
				.catch((error) => {
					ctx.ui.setWidget(widgetKey, undefined);
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
		},
	});
}
