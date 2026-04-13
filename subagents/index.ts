import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { runSubagent, runSubagentBatch } from "./core.js";

function formatResult(tool: string, result: Awaited<ReturnType<typeof runSubagent>>) {
	if (result.exitCode !== 0) {
		return {
			content: [{ type: "text" as const, text: `${tool} failed: ${result.errorMessage ?? result.output ?? "Unknown error"}` }],
			isError: true,
			details: { result },
		};
	}
	return {
		content: [{ type: "text" as const, text: result.output || "(no output)" }],
		details: { result },
	};
}

export default function (pi: ExtensionAPI) {
	const api = { runSubagent, runSubagentBatch };
	pi.events.emit("magpie:subagent-core:register", api);
	pi.events.on("magpie:subagent-core:get", (callback: (value: unknown) => void) => {
		callback(api);
	});

	const commonParams = Type.Object({
		task: Type.String({ description: "What the subagent should investigate or do" }),
		model: Type.Optional(Type.String({ description: "Optional explicit model override (provider/model-id)" })),
		thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
	});

	pi.registerTool({
		name: "search_subagent",
		label: "Search Subagent",
		description: "Ask a fast read-only subagent to retrieve relevant files, symbols, call paths, or code patterns.",
		promptSnippet: "Use Search subagent for fast codebase retrieval when local evidence is needed.",
		promptGuidelines: ["Use when you need targeted codebase discovery without doing the retrieval yourself."],
		parameters: commonParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const result = await runSubagent(ctx, config, {
				role: "search",
				label: "search",
				task: params.task,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: "readonly",
			}, signal);
			return formatResult("search_subagent", result);
		},
	});

	pi.registerTool({
		name: "oracle_subagent",
		label: "Oracle Subagent",
		description: "Ask a stronger reasoning subagent to analyze tradeoffs, root causes, architecture, or complex debugging paths.",
		promptSnippet: "Use Oracle subagent for deeper reasoning, architecture analysis, and complex debugging.",
		promptGuidelines: ["Use for non-trivial reasoning tasks where evidence should be gathered before conclusions."],
		parameters: commonParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const result = await runSubagent(ctx, config, {
				role: "oracle",
				label: "oracle",
				task: params.task,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: "readonly",
			}, signal);
			return formatResult("oracle_subagent", result);
		},
	});

	pi.registerTool({
		name: "librarian_subagent",
		label: "Librarian Subagent",
		description: "Ask a research subagent to investigate docs, external APIs, prior sessions, and historical context.",
		promptSnippet: "Use Librarian subagent for docs, external research, and historical/session context.",
		promptGuidelines: ["Use when the answer likely depends on documentation, external systems, or prior threads."],
		parameters: commonParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const result = await runSubagent(ctx, config, {
				role: "librarian",
				label: "librarian",
				task: params.task,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: "readonly",
			}, signal);
			return formatResult("librarian_subagent", result);
		},
	});
}
