import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return the page content as markdown. Uses defuddle.md to extract clean, readable content from web pages.",
    promptSnippet: "Fetch a web page and return its content as markdown",
    promptGuidelines: [
      "Use this tool when you need to read the contents of a web page.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to fetch (must be a valid http or https URL)",
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Fetching: ${params.url}...` }],
      });

      const result = await pi.exec(
        "curl",
        ["-sL", `https://defuddle.md/${params.url}`],
        { signal, timeout: 30000 },
      );

      if (result.code !== 0) {
        throw new Error(`web_fetch failed (exit ${result.code}): ${result.stderr}`);
      }

      return {
        content: [{ type: "text", text: result.stdout }],
        details: { stderr: result.stderr },
      };
    },
  });
}
