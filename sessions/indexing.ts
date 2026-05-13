import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { convertToLlm, SessionManager, serializeConversation, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { dedupeSessionEntries } from "./format.js";
import { loadSessionIndex, upsertIndexEntry } from "./indexer.js";
import type { SessionIndexEntry } from "./types.js";

const SESSION_INDEX_FILENAMES = new Set(["magpie-session-index.jsonl", "magpie-index-pending.jsonl"]);

function buildSessionConversation(entries: SessionEntry[]): string {
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
	return serializeConversation(convertToLlm(messages));
}

export function getSessionRootDir(ctx: ExtensionContext): string | undefined {
	const currentSessionPath = ctx.sessionManager.getSessionFile();
	if (!currentSessionPath) return undefined;
	return dirname(currentSessionPath);
}

export async function listSessionFiles(rootDir: string): Promise<string[]> {
	const results: string[] = [];
	const walk = async (dir: string) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			if (SESSION_INDEX_FILENAMES.has(entry.name)) continue;
			results.push(path);
		}
	};
	await walk(rootDir);
	results.sort((a, b) => a.localeCompare(b));
	return results;
}

export async function answerQuestionFromSession(
	core: SubagentCoreAPI,
	ctx: ExtensionContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	sessionPath: string,
	question: string,
) {
	const manager = SessionManager.open(sessionPath);
	const branch = manager.getBranch();
	const conversationText = buildSessionConversation(branch);
	return core.runSubagent(ctx, config, {
		role: "session",
		label: "session-query",
		task: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${question}`,
		tools: [],
		timeout: 180000,
	});
}

export async function summarizeSession(
	core: SubagentCoreAPI,
	ctx: ExtensionContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	sessionPath: string,
	cwd: string,
): Promise<SessionIndexEntry | null> {
	if (!existsSync(sessionPath)) return null;
	let manager: SessionManager;
	try {
		manager = SessionManager.open(sessionPath);
	} catch {
		return null;
	}
	const branch = manager.getBranch();
	const messages = branch.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message");
	if (messages.length < 3) return null;
	const conversationText = buildSessionConversation(branch);
	const result = await core.runSubagent(ctx, config, {
		role: "memory",
		label: "session-index",
		systemPrompt: "You are a session indexing summarizer. Your only job is to summarize one coding session as structured JSON for the session index. Focus on what happened in the session itself: the main work, topics, and files modified. Do not apply the broader Magpie memory-worker behavior here. Return only the requested JSON.",
		task: [
			"Summarize this session as JSON.",
			"Return exactly one JSON object with fields: summary (string), topics (string[]), filesModified (string[]).",
			"Keep summary to 2-4 sentences.",
			"Conversation:",
			conversationText,
		].join("\n\n"),
		tools: [],
		timeout: 180000,
	});
	if (result.exitCode !== 0 || !result.output.trim()) return null;
	let parsed: { summary?: string; topics?: string[]; filesModified?: string[] };
	try {
		parsed = JSON.parse(result.output.trim()) as { summary?: string; topics?: string[]; filesModified?: string[] };
	} catch {
		return null;
	}
	const modelsUsed = Array.from(
		new Set(
			branch
				.filter((entry: any) => entry.type === "model_change")
				.map((entry: any) => `${entry.provider}/${entry.modelId}`),
		),
	);
	const startedTimestamp = branch[0]?.timestamp ? new Date(branch[0].timestamp).toISOString() : new Date().toISOString();
	const lastTimestamp = branch[branch.length - 1]?.timestamp;
	return {
		sessionId: manager.getSessionId(),
		sessionPath,
		startedAt: startedTimestamp,
		endedAt: lastTimestamp ? new Date(lastTimestamp).toISOString() : new Date().toISOString(),
		cwd,
		messageCount: messages.length,
		modelsUsed,
		summary: parsed.summary ?? "",
		topics: Array.isArray(parsed.topics) ? parsed.topics : [],
		filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified : [],
	};
}

export async function runSessionIndexingMode(
	mode: "sync" | "reindex-all",
	ctx: ExtensionContext,
	subagentCore: SubagentCoreAPI | null,
): Promise<string> {
	if (!subagentCore) return "Subagent core unavailable.";
	const rootDir = getSessionRootDir(ctx);
	if (!rootDir) return "Current session file unavailable. Cannot locate session directory.";
	const sessionFiles = await listSessionFiles(rootDir);
	if (sessionFiles.length === 0) return `No session files found under ${rootDir}.`;
	const config = await loadConfig(ctx.cwd);
	const indexed = dedupeSessionEntries(await loadSessionIndex());
	const indexedPaths = new Set(indexed.map((entry) => entry.sessionPath));
	const targets = mode === "sync" ? sessionFiles.filter((path) => !indexedPaths.has(path)) : sessionFiles;
	if (targets.length === 0) return mode === "sync" ? "All discovered sessions are already indexed." : "No session files found to reindex.";
	let indexedCount = 0;
	let skippedCount = 0;
	for (let i = 0; i < targets.length; i++) {
		const sessionPath = targets[i]!;
		const entry = await summarizeSession(subagentCore, ctx, config, sessionPath, ctx.cwd);
		if (!entry) {
			skippedCount++;
			continue;
		}
		await upsertIndexEntry(entry, config.sessions?.maxIndexEntries ?? 500);
		indexedCount++;
	}
	return `${mode === "sync" ? "Synced" : "Reindexed"} ${indexedCount} session(s) from ${rootDir}.${skippedCount ? ` Skipped ${skippedCount} file(s).` : ""}`;
}
