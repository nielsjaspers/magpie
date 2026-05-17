import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";

type RunSubagent = typeof import("./core.js").runSubagent;
type RunSubagentBatch = typeof import("./core.js").runSubagentBatch;
type SubagentCoreModule = typeof import("./core.js");

let coreModulePromise: Promise<SubagentCoreModule> | null = null;

async function getSubagentCoreModule(): Promise<SubagentCoreModule> {
	coreModulePromise ??= import("./core.js");
	return coreModulePromise;
}

function runSubagent(...args: Parameters<RunSubagent>): ReturnType<RunSubagent> {
	return getSubagentCoreModule().then((core) => core.runSubagent(...args)) as ReturnType<RunSubagent>;
}

function runSubagentBatch(...args: Parameters<RunSubagentBatch>): ReturnType<RunSubagentBatch> {
	return getSubagentCoreModule().then((core) => core.runSubagentBatch(...args)) as ReturnType<RunSubagentBatch>;
}

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
	pi.events.on("magpie:subagent-core:get", (callback: unknown) => {
		if (typeof callback === "function") callback(api);
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate a focused investigation or task to a subagent.",
		promptSnippet: "Use delegate for focused subagent help when parallel investigation or deeper analysis would be useful.",
		promptGuidelines: ["delegate: Use for focused codebase retrieval, deeper reasoning, docs/prior-session research, or other subagent work."],
		parameters: Type.Object({
			task: Type.String({ description: "What the subagent should investigate or do" }),
			model: Type.Optional(Type.String({ description: "Optional explicit model override (provider/model-id)" })),
			thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const result = await runSubagent(ctx, config, {
				role: "delegate",
				label: "delegate",
				task: params.task,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: "readonly",
			}, signal);
			return formatResult("delegate", result);
		},
	});
}
