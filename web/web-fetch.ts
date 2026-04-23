import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a URL and return the page content as markdown. Uses defuddle.md to extract clean, readable content from web pages.",
		promptSnippet: "Fetch a web page and return its content as markdown",
		promptGuidelines: ["web_fetch: Use this tool when you need to read the contents of a web page."],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (must be a valid http or https URL)" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Fetching: ${params.url}...` }], details: { url: params.url } });
			const config = await loadConfig(ctx.cwd);
			const result = await pi.exec("curl", ["-sL", `https://defuddle.md/${params.url}`], {
				signal,
				timeout: config.web?.fetchTimeout ?? 30000,
			});
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `web_fetch failed (exit ${result.code}): ${result.stderr}` }],
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
