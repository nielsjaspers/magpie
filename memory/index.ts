import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { addMemory, forgetMemory, getDefaultMemoryStorePath, loadMemories, searchMemories } from "./store.js";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\nYou have access to a long-term memory store from previous sessions. If the user asks you to remember something, use the save_memory tool. If you need to recall previous decisions, preferences, or context, use the recall_memories tool.`,
		};
	});

	pi.registerCommand("remember", {
		description: "Store a memory: /remember <text>",
		handler: async (args, ctx) => {
			const content = args?.trim();
			if (!content) {
				ctx.ui.notify("Usage: /remember <text>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const entry = await addMemory(content, undefined, "user", config.memory?.storePath ?? getDefaultMemoryStorePath());
			ctx.ui.notify(`Saved memory ${entry.id}`, "info");
		},
	});

	pi.registerCommand("forget", {
		description: "Deactivate a memory: /forget <id or search text>",
		handler: async (args, ctx) => {
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /forget <id or search text>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const entry = await forgetMemory(query, config.memory?.storePath ?? getDefaultMemoryStorePath());
			ctx.ui.notify(entry ? `Forgot memory ${entry.id}` : "No matching memory.", entry ? "info" : "warning");
		},
	});

	pi.registerCommand("memories", {
		description: "List or search memories: /memories [search <query>]",
		handler: async (args, ctx) => {
			const config = await loadConfig(ctx.cwd);
			const path = config.memory?.storePath ?? getDefaultMemoryStorePath();
			const memories = await loadMemories(path);
			const raw = args?.trim() ?? "";
			const selected = raw.startsWith("search ") ? searchMemories(memories, raw.slice("search ".length).trim()) : memories.filter((memory) => memory.active);
			ctx.ui.notify(selected.length ? selected.map((memory) => `${memory.id} [${memory.category ?? "uncategorized"}] ${memory.content}`).join("\n") : "No memories found.", "info");
		},
	});

	pi.registerTool({
		name: "save_memory",
		label: "Save Memory",
		description: "Save a fact, decision, or preference to long-term memory for future sessions.",
		parameters: Type.Object({
			content: Type.String({ description: "The memory to save" }),
			category: Type.Optional(StringEnum(["preference", "decision", "context", "project", "convention"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const entry = await addMemory(params.content.trim(), params.category, "user", config.memory?.storePath ?? getDefaultMemoryStorePath());
			return { content: [{ type: "text", text: `Saved memory ${entry.id}` }], details: { id: entry.id } };
		},
	});

	pi.registerTool({
		name: "recall_memories",
		label: "Recall Memories",
		description: "Search long-term memory for relevant facts, decisions, preferences, or context from previous sessions.",
		parameters: Type.Object({
			query: Type.String({ description: "What to search for in memories" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			if (config.memory?.enabled === false) {
				return { content: [{ type: "text", text: "Memory system is disabled." }], details: {}, isError: true };
			}
			const path = config.memory?.storePath ?? getDefaultMemoryStorePath();
			const memories = await loadMemories(path);
			const results = searchMemories(memories, params.query.trim()).slice(0, config.memory?.maxRetrieved ?? 20);
			if (results.length === 0) return { content: [{ type: "text", text: "No matching memories." }], details: { results: [] } };
			return { content: [{ type: "text", text: results.map((memory) => `- [${memory.category ?? "uncategorized"}] ${memory.content}`).join("\n") }], details: { results } };
		},
	});
}
