import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, getMarkdownTheme, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { loadConfig } from "../config/config.js";
import type { SubagentCoreAPI, SubagentResult } from "../subagents/types.js";

const COMMIT_MESSAGE_TYPE = "magpie:commit-result";

function parseFlags(input: string): { prompt?: string; model?: string } {
	let remaining = input;
	let model: string | undefined;
	const modelMatch = remaining.match(/(?:^|\s)-{1,2}model\s+(\S+)/);
	if (modelMatch) {
		model = modelMatch[1];
		remaining = remaining.replace(modelMatch[0], " ");
	}
	const prompt = remaining.trim();
	return { prompt: prompt || undefined, model };
}

function renderProgress(result: SubagentResult): string[] {
	const lines = ["⏳ commit: analyzing changes"];
	for (const item of result.displayItems.slice(-6)) {
		if (item.type === "toolCall") lines.push(`  → ${item.name}`);
	}
	if (result.output) lines.push(`  ${result.output.split("\n")[0]}`);
	return lines;
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});
	pi.events.emit("magpie:subagent-core:get", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});

	pi.on("context", (event) => {
		return { messages: event.messages.filter((message: any) => !(message.role === "custom" && message.customType === COMMIT_MESSAGE_TYPE)) };
	});

	pi.registerMessageRenderer<{ summary: string; result: SubagentResult }>(COMMIT_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		const container = new Container();
		container.addChild(new Text(`${theme.bold("commit:")} ${details.summary}`, 0, 0));
		for (const item of details.result.displayItems) {
			if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", `→ ${item.name}`), 0, 0));
		}
		if (details.result.output) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(details.result.output, 0, 0, getMarkdownTheme()));
		}
		return container;
	});

	pi.registerCommand("commit", {
		description: "Create a git commit in the background (-model <provider/modelId>)",
		handler: async (args, ctx) => {
			if (!subagentCore) {
				ctx.ui.notify("Subagent core unavailable.", "error");
				return;
			}
			const { prompt, model } = parseFlags(args ?? "");
			const config = await loadConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message)
				.filter((message: any) => !message?.customType);
			const conversationContext = messages.length > 0 ? serializeConversation(convertToLlm(messages)) : "";
			const task = [
				"Quickly inspect the repo's recent commit style and the current changes, then create a git commit directly.",
				"Required steps:",
				"1. Check git status and determine whether staged changes exist; if nothing is staged, inspect recent changes and stage the most relevant tracked modifications needed for a coherent commit.",
				"2. Inspect recent commit messages (for example the last 10-20 commits) to infer this repository's commit style.",
				"3. Inspect the staged diff (or stage first if needed, then inspect) quickly but carefully.",
				"4. Write a concise commit message matching repo style.",
				"5. Run git commit directly.",
				"6. Report exactly what commit was created, or explain why no commit was made.",
				prompt ? `Additional user guidance: ${prompt}` : undefined,
			].filter(Boolean).join("\n");
			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task\n\n${task}`
				: task;
			const widgetKey = `magpie-commit-${Date.now()}`;
			ctx.ui.setWidget(widgetKey, ["⏳ commit: analyzing changes"], { placement: "aboveEditor" });
			void subagentCore.runSubagent(
				ctx,
				config,
				{
					role: "commit",
					label: "commit",
					task: taskWithContext,
					context: [
						"You are running as a background /commit subagent.",
						"Use the parent conversation as supporting context, but do not emit or rely on custom background-subagent messages.",
						"Do not hand off or spawn further subagents.",
						"Be fast, prefer a single coherent commit, and execute git commands yourself.",
					].join("\n"),
					model,
					tools: "readonly",
				},
				undefined,
				(progress) => {
					ctx.ui.setWidget(widgetKey, renderProgress({
						spec: { role: "commit", label: "commit", task },
						output: progress.partialOutput,
						displayItems: progress.toolCalls.map((call) => ({ type: "toolCall" as const, name: call.name, args: call.args })),
						exitCode: -1,
						usage: progress.usage,
						model: model ?? "",
						stopReason: undefined,
					}), { placement: "aboveEditor" });
				},
			)
				.then((result) => {
					const summary = result.exitCode === 0 ? "✓ commit completed" : "✗ commit failed";
					pi.sendMessage({
						customType: COMMIT_MESSAGE_TYPE,
						content: [{ type: "text", text: `[commit ${result.exitCode === 0 ? "✓" : "✗"}] ${summary}` }],
						display: true,
						details: { summary, result },
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
