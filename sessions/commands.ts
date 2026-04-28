import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { dedupeSessionEntries } from "./format.js";
import { loadPendingIndexEntries, loadSessionIndex, scoreSessionEntry, upsertIndexEntry } from "./indexer.js";
import { runSessionIndexingMode, summarizeSession } from "./indexing.js";
import { resolveSessionPath } from "./parse.js";

const DEFAULT_GET_SESSIONS_LIMIT = 10;

export async function handleSessionsCommand(args: string | undefined, ctx: ExtensionContext, subagentCore: SubagentCoreAPI | null) {
	const raw = args?.trim() ?? "";
	if (!raw) {
		const recent = dedupeSessionEntries(await loadSessionIndex())
			.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
			.slice(0, DEFAULT_GET_SESSIONS_LIMIT);
		ctx.ui.notify(recent.length ? recent.map((entry) => `${entry.endedAt}  ${entry.summary}`).join("\n") : "No indexed sessions yet.", "info");
		return;
	}
	if (raw.startsWith("search ")) {
		const query = raw.slice("search ".length).trim();
		const results = dedupeSessionEntries(await loadSessionIndex())
			.map((entry) => ({ entry, score: scoreSessionEntry(entry, query) }))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, DEFAULT_GET_SESSIONS_LIMIT);
		ctx.ui.notify(results.length ? results.map(({ entry }) => `${entry.sessionPath}\n- ${entry.summary}`).join("\n\n") : "No matches.", "info");
		return;
	}
	if (raw === "pending") {
		const pending = await loadPendingIndexEntries();
		ctx.ui.notify(pending.length ? pending.map((entry) => `${entry.sessionPath} (attempts: ${entry.attempts})`).join("\n") : "No pending entries.", "info");
		return;
	}
	if (raw === "sync") {
		ctx.ui.notify(await runSessionIndexingMode("sync", ctx, subagentCore), "info");
		return;
	}
	if (raw === "reindex-all") {
		ctx.ui.notify(await runSessionIndexingMode("reindex-all", ctx, subagentCore), "info");
		return;
	}
	if (raw.startsWith("reindex ")) {
		if (!subagentCore) {
			ctx.ui.notify("Subagent core unavailable.", "error");
			return;
		}
		const sessionPath = resolveSessionPath(raw.slice("reindex ".length).trim(), ctx.cwd);
		const config = await loadConfig(ctx.cwd);
		const entry = await summarizeSession(subagentCore, ctx, config, sessionPath, ctx.cwd);
		if (!entry) {
			ctx.ui.notify("Failed to index session.", "error");
			return;
		}
		await upsertIndexEntry(entry, config.sessions?.maxIndexEntries ?? 500);
		ctx.ui.notify(`Indexed ${sessionPath}`, "info");
		return;
	}
	ctx.ui.notify("Usage: /sessions, /sessions search <query>, /sessions pending, /sessions sync, /sessions reindex <path>, /sessions reindex-all", "warning");
}
