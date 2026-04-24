import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { expandHomePath, loadConfig } from "../config/config.js";
import { addPreference, forgetPreference, getDefaultPreferenceStorePath, loadPreferences, searchPreferences } from "./store.js";

function getPreferenceStorePath(config: Awaited<ReturnType<typeof loadConfig>>): string {
	return expandHomePath(config.preferences?.storePath?.trim() || getDefaultPreferenceStorePath());
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("save-preference", {
		description: "Store a durable preference: /save-preference <text>",
		handler: async (args, ctx) => {
			const content = args?.trim();
			if (!content) {
				ctx.ui.notify("Usage: /save-preference <text>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const entry = await addPreference(content, undefined, "user", getPreferenceStorePath(config));
			ctx.ui.notify(`Saved preference ${entry.id}`, "info");
		},
	});

	pi.registerCommand("forget-preference", {
		description: "Deactivate a stored preference: /forget-preference <id or search text>",
		handler: async (args, ctx) => {
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /forget-preference <id or search text>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const entry = await forgetPreference(query, getPreferenceStorePath(config));
			ctx.ui.notify(entry ? `Forgot preference ${entry.id}` : "No matching preference.", entry ? "info" : "warning");
		},
	});

	pi.registerCommand("preferences", {
		description: "List or search saved preferences: /preferences [search <query>]",
		handler: async (args, ctx) => {
			const config = await loadConfig(ctx.cwd);
			const path = getPreferenceStorePath(config);
			const preferences = await loadPreferences(path);
			const raw = args?.trim() ?? "";
			const selected = raw.startsWith("search ") ? searchPreferences(preferences, raw.slice("search ".length).trim()) : preferences.filter((preference) => preference.active);
			ctx.ui.notify(selected.length ? selected.map((preference) => `${preference.id} [${preference.category ?? "uncategorized"}] ${preference.content}`).join("\n") : "No preferences found.", "info");
		},
	});

	pi.registerTool({
		name: "save_preference",
		label: "Save Preference",
		description: "Save a small durable preference, convention, or behavior setting for future sessions. This is not the life-memory graph.",
		promptSnippet: "Save a small durable preference, convention, or behavior setting for future sessions.",
		parameters: Type.Object({
			content: Type.String({ description: "The preference to save" }),
			category: Type.Optional(StringEnum(["preference", "decision", "context", "project", "convention"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const entry = await addPreference(params.content.trim(), params.category, "user", getPreferenceStorePath(config));
			return { content: [{ type: "text", text: `Saved preference ${entry.id}` }], details: { id: entry.id } };
		},
	});

	pi.registerTool({
		name: "recall_preferences",
		label: "Recall Preferences",
		description: "List or search stored preferences, conventions, decisions, and other small durable facts. This does not query the new memory graph.",
		promptSnippet: "List or search stored preferences; omit query to list recent preferences or provide query to search.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "What to search for in preferences. Omit to list recent preferences." })),
			offset: Type.Optional(Type.Integer({ description: "Number of preferences to skip (default 0).", minimum: 0 })),
			limit: Type.Optional(Type.Integer({ description: "Maximum number of preferences to return (default 10, max 50).", minimum: 1, maximum: 50 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			if (config.preferences?.enabled === false) {
				return { content: [{ type: "text", text: "Preferences system is disabled." }], details: {}, isError: true };
			}
			const preferences = await loadPreferences(getPreferenceStorePath(config));
			const limit = Math.min(params.limit ?? 10, 50);
			const offset = params.offset ?? 0;

			let results;
			if (params.query?.trim()) {
				results = searchPreferences(preferences, params.query.trim());
			} else {
				results = preferences.filter((preference) => preference.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			}

			const page = results.slice(offset, offset + limit);
			if (page.length === 0) return { content: [{ type: "text", text: "No matching preferences." }], details: { results: [], total: results.length } };
			return {
				content: [{ type: "text", text: page.map((preference) => `- [${preference.category ?? "uncategorized"}] ${preference.content}`).join("\n") }],
				details: { results: page, total: results.length, offset, limit },
			};
		},
	});
}
