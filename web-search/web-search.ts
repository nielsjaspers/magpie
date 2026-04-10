import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using OpenCode. Use this when you need current information from the internet.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: ["Use this tool when you need up-to-date information that might not be in your training data."],
    parameters: Type.Object({
      query: Type.String({ description: "The search query to run" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Searching web for: ${params.query}...` }],
      });

      // Escape the query for the shell command
      const escapedQuery = params.query.replace(/"/g, '\\"');
      
      const result = await pi.exec(
        "bash", 
        ["-c", `OPENCODE_ENABLE_EXA=1 opencode run "${escapedQuery}" --model "github-copilot/gemini-3-flash-preview"`],
        { signal, timeout: 120000 }
      );

      if (result.code !== 0) {
        throw new Error(`Web search failed: ${result.stderr}`);
      }

      return {
        content: [{ type: "text", text: result.stdout }],
        details: { stderr: result.stderr },
      };
    },
  });
}