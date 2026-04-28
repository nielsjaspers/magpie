import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";

export function buildWebSearchCommand(query: string, model: string) {
	return {
		command: "env",
		args: ["OPENCODE_ENABLE_EXA=1", "opencode", "run", query, "--model", model],
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using OpenCode. Use this when you need current information from the internet.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: ["web_search: Use this tool when you need up-to-date information that might not be in your training data."],
		parameters: Type.Object({
			query: Type.String({ description: "The search query to run" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Searching web for: ${params.query}...` }], details: { query: params.query } });
			const config = await loadConfig(ctx.cwd);
			const command = buildWebSearchCommand(params.query, config.web?.searchModel ?? "opencode-go/mimo-v2-pro");
			const result = await pi.exec(
				command.command,
				command.args,
				{ signal, timeout: config.web?.searchTimeout ?? 120000 },
			);
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `Web search failed: ${result.stderr}` }],
					details: { stderr: result.stderr, code: result.code },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: result.stdout }],
				details: { stderr: result.stderr },
			};
		},
	});
}
