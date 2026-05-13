import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { htmlToText } from "html-to-text";
import { loadConfig } from "../config/config.js";

const BROWSER_HEADERS = [
	"-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
	"-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
	"-H", "Accept-Language: en-US,en;q=0.9",
	"-H", "Cache-Control: no-cache",
	"-H", "Pragma: no-cache",
	"--compressed",
];

function validateHttpUrl(raw: string) {
	const parsed = new URL(raw);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must use http or https.");
	return parsed.toString();
}

function looksLikeCloudflareChallenge(text: string) {
	const lower = text.slice(0, 20000).toLowerCase();
	return lower.includes("cf-browser-verification")
		|| lower.includes("challenge-platform")
		|| lower.includes("checking your browser")
		|| lower.includes("just a moment...") && lower.includes("cloudflare")
		|| lower.includes("enable javascript and cookies to continue") && lower.includes("cloudflare");
}

function htmlToMarkdownish(html: string) {
	return htmlToText(html, {
		wordwrap: false,
		selectors: [
			{ selector: "a", options: { ignoreHref: false } },
			{ selector: "img", format: "skip" },
			{ selector: "script", format: "skip" },
			{ selector: "style", format: "skip" },
		],
	}).trim();
}

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
			let targetUrl: string;
			try {
				targetUrl = validateHttpUrl(params.url);
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching: ${targetUrl}...` }], details: { url: targetUrl } });
			const config = await loadConfig(ctx.cwd);
			const timeout = config.web?.fetchTimeout ?? 30000;

			const defuddle = await pi.exec("curl", ["-sSLf", ...BROWSER_HEADERS, `https://defuddle.md/${targetUrl}`], { signal, timeout });
			if (defuddle.code === 0 && defuddle.stdout.trim() && !looksLikeCloudflareChallenge(defuddle.stdout)) {
				return {
					content: [{ type: "text", text: defuddle.stdout }],
					details: { stderr: defuddle.stderr, source: "defuddle" },
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `Defuddle was blocked or empty; trying direct browser-like fetch: ${targetUrl}...` }], details: { url: targetUrl } });
			const direct = await pi.exec("curl", ["-sSLf", ...BROWSER_HEADERS, targetUrl], { signal, timeout });
			if (direct.code === 0 && direct.stdout.trim() && !looksLikeCloudflareChallenge(direct.stdout)) {
				const rendered = htmlToMarkdownish(direct.stdout) || direct.stdout;
				return {
					content: [{ type: "text", text: rendered }],
					details: { stderr: direct.stderr, source: "direct" },
				};
			}

			const blockedByCloudflare = looksLikeCloudflareChallenge(defuddle.stdout) || looksLikeCloudflareChallenge(direct.stdout);
			const errors = [
				defuddle.code !== 0 ? `defuddle exit ${defuddle.code}: ${defuddle.stderr}` : undefined,
				direct.code !== 0 ? `direct exit ${direct.code}: ${direct.stderr}` : undefined,
			].filter(Boolean).join("\n");
			return {
				content: [{
					type: "text",
					text: blockedByCloudflare
						? `web_fetch was blocked by a Cloudflare/browser challenge for ${targetUrl}. Browser-like headers were tried, but this site requires a real browser session or a fetch proxy/browserless service.\n${errors}`.trim()
						: `web_fetch failed for ${targetUrl}.\n${errors || "No readable content returned."}`.trim(),
				}],
				details: {
					defuddle: { stderr: defuddle.stderr, code: defuddle.code, cloudflare: looksLikeCloudflareChallenge(defuddle.stdout) },
					direct: { stderr: direct.stderr, code: direct.code, cloudflare: looksLikeCloudflareChallenge(direct.stdout) },
				},
				isError: true,
			};
		},
	});
}
