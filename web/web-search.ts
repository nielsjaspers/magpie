import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";

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
			const escapedQuery = params.query.replace(/"/g, '\\"');
			const result = await pi.exec(
				"bash",
				["-lc", `OPENCODE_ENABLE_EXA=1 opencode run \"${escapedQuery}\" --model \"${config.web?.searchModel ?? "opencode-go/mimo-v2-pro"}\"`],
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
