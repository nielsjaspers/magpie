import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { convertToLlm, getMarkdownTheme, SessionManager, serializeConversation, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { addPendingIndexEntry, loadPendingIndexEntries, loadSessionIndex, scoreSessionEntry, updatePendingIndexEntries, upsertIndexEntry } from "./indexer.js";
import type { PendingIndexEntry, SessionIndexEntry } from "./types.js";
import type { SubagentCoreAPI } from "../subagents/types.js";

const MAX_GET_SESSIONS_LIMIT = 50;
const DEFAULT_GET_SESSIONS_LIMIT = 10;
const SESSION_INDEX_FILENAMES = new Set(["magpie-session-index.jsonl", "magpie-index-pending.jsonl"]);
type SessionSort = "oldest" | "newest" | "best_match";

function messageToText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as any).type === "text" && typeof (block as any).text === "string")
		.map((block) => block.text)
		.join("\n");
}

function normalizeSessionPath(raw: string): string {
	return raw.trim().replace(/^`+|`+$/g, "").replace(/^\"+|\"+$/g, "").trim();
}

function parseParentSessionPath(text: string): string | undefined {
	const markdownMatch = text.match(/\*\*Parent session:\*\*\s*`([^`]+)`/i);
	if (markdownMatch?.[1]) return normalizeSessionPath(markdownMatch[1]);
	const plainMatch = text.match(/Parent session:\s*([^\n]+)/i);
	if (plainMatch?.[1]) return normalizeSessionPath(plainMatch[1]);
	return undefined;
}

function resolveSessionPath(inputPath: string, cwd: string): string {
	if (inputPath.startsWith("/")) return inputPath;
	if (inputPath.startsWith("~")) return inputPath.replace("~", process.env.HOME ?? "~");
	return resolve(cwd, inputPath);
}

function findParentSessionPathFromCurrentBranch(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message as { content?: unknown });
	for (let i = messages.length - 1; i >= 0; i--) {
		const path = parseParentSessionPath(messageToText(messages[i]!));
		if (path) return path;
	}
	return undefined;
}

function buildSessionConversation(entries: SessionEntry[]): string {
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
	return serializeConversation(convertToLlm(messages));
}

function dedupeSessionEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
	const byPath = new Map<string, SessionIndexEntry>();
	for (const entry of entries) {
		const existing = byPath.get(entry.sessionPath);
		if (!existing) {
			byPath.set(entry.sessionPath, entry);
			continue;
		}
		const existingEndedAt = Date.parse(existing.endedAt);
		const nextEndedAt = Date.parse(entry.endedAt);
		if (!Number.isFinite(existingEndedAt) || nextEndedAt >= existingEndedAt) byPath.set(entry.sessionPath, entry);
	}
	return Array.from(byPath.values());
}

function parseDateBoundary(raw: string | undefined, boundary: "start" | "end"): number | undefined {
	if (!raw?.trim()) return undefined;
	const value = raw.trim();
	const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		const date = boundary === "start"
			? new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
			: new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
		const ts = date.getTime();
		return Number.isFinite(ts) ? ts : undefined;
	}
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}

function sessionOverlapsRange(entry: SessionIndexEntry, fromMs?: number, toMs?: number): boolean {
	const startedAt = Date.parse(entry.startedAt);
	const endedAt = Date.parse(entry.endedAt);
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return false;
	if (fromMs !== undefined && endedAt < fromMs) return false;
	if (toMs !== undefined && startedAt > toMs) return false;
	return true;
}

function compareSessions(a: { entry: SessionIndexEntry; score: number }, b: { entry: SessionIndexEntry; score: number }, sort: SessionSort): number {
	if (sort === "best_match") {
		if (b.score !== a.score) return b.score - a.score;
		return Date.parse(b.entry.startedAt) - Date.parse(a.entry.startedAt);
	}
	if (sort === "oldest") return Date.parse(a.entry.startedAt) - Date.parse(b.entry.startedAt);
	return Date.parse(b.entry.startedAt) - Date.parse(a.entry.startedAt);
}

function formatSessionListResult(entries: SessionIndexEntry[], meta: { query?: string; from?: string; to?: string; sort: SessionSort; limit: number }): string {
	const lines = [
		`**Count:** ${entries.length}`,
		`**Sort:** ${meta.sort}`,
		`**Limit:** ${meta.limit}`,
	];
	if (meta.query) lines.push(`**Query:** ${meta.query}`);
	if (meta.from) lines.push(`**From:** ${meta.from}`);
	if (meta.to) lines.push(`**To:** ${meta.to}`);
	if (entries.length === 0) return [...lines, "", "No indexed sessions matched those filters."].join("\n");
	return [
		...lines,
		"",
		...entries.map((entry, index) => [
			`${index + 1}. \`${entry.sessionPath}\``,
			`   - startedAt: ${entry.startedAt}`,
			`   - endedAt: ${entry.endedAt}`,
			`   - cwd: ${entry.cwd}`,
			`   - messageCount: ${entry.messageCount}`,
			`   - summary: ${entry.summary || "(none)"}`,
			`   - topics: ${entry.topics.length ? entry.topics.join(", ") : "(none)"}`,
			`   - filesModified: ${entry.filesModified.length ? entry.filesModified.join(", ") : "(none)"}`,
		].join("\n")),
	].join("\n");
}

function getSessionRootDir(ctx: ExtensionContext): string | undefined {
	const currentSessionPath = ctx.sessionManager.getSessionFile();
	if (!currentSessionPath) return undefined;
	return dirname(currentSessionPath);
}

async function listSessionFiles(rootDir: string): Promise<string[]> {
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

async function answerQuestionFromSession(
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

async function summarizeSession(
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

async function runSessionIndexingMode(
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

async function handleSessionsCommand(args: string | undefined, ctx: ExtensionContext, subagentCore: SubagentCoreAPI | null) {
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

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: any) => {
		subagentCore = api as SubagentCoreAPI;
	});
	pi.events.emit("magpie:subagent-core:get", (api: any) => {
		subagentCore = api as SubagentCoreAPI;
	});

	const runIndexAttempt = async (
		ctx: ExtensionContext,
		pending: PendingIndexEntry,
		configOverride?: Awaited<ReturnType<typeof loadConfig>>,
	) => {
		if (!subagentCore) return false;
		const config = configOverride ?? await loadConfig(ctx.cwd);
		const entry = await summarizeSession(subagentCore, ctx, config, pending.sessionPath, pending.cwd);
		if (!entry) return false;
		await upsertIndexEntry(entry, config.sessions?.maxIndexEntries ?? 500);
		return true;
	};

	let pendingDrainScheduled = false;
	let pendingDrainPromise: Promise<void> | null = null;

	const drainPendingIndexEntries = async (ctx: ExtensionContext) => {
		if (!subagentCore) return;
		const pending = await loadPendingIndexEntries();
		if (pending.length === 0) return;
		const config = await loadConfig(ctx.cwd);
		if (config.sessions?.autoIndex === false) return;
		const remaining: PendingIndexEntry[] = [];
		for (const entry of pending) {
			if (!existsSync(entry.sessionPath)) continue;
			if (entry.attempts >= 3) {
				remaining.push(entry);
				continue;
			}
			const attempted = { ...entry, attempts: entry.attempts + 1 };
			const ok = await runIndexAttempt(ctx, attempted, config);
			if (!ok) remaining.push(attempted);
		}
		await updatePendingIndexEntries(remaining);
	};

	const schedulePendingIndexDrain = (ctx: ExtensionContext) => {
		if (pendingDrainScheduled || pendingDrainPromise) return;
		pendingDrainScheduled = true;
		setTimeout(() => {
			pendingDrainScheduled = false;
			pendingDrainPromise = drainPendingIndexEntries(ctx)
				.catch(() => {
					// best-effort background indexing
				})
				.finally(() => {
					pendingDrainPromise = null;
				});
		}, 0);
	};

	pi.registerTool({
		name: "get_sessions",
		label: "Get Sessions",
		description: "List indexed Pi sessions with paths, summaries, topics, files, and timestamps so you can choose sessionPath values for session_query.",
		promptSnippet: "Use this to discover candidate sessions before calling session_query.",
		promptGuidelines: [
			"get_sessions: Use this first when the user asks for sessions by date, date range, topic, or fuzzy keyword search.",
			"get_sessions: Convert natural-language ranges like 'yesterday', 'last week', or 'between April 1st and 4th' into explicit from/to timestamps before calling the tool.",
			"get_sessions: from/to are overlap filters against session startedAt and endedAt, so include the full requested window. For whole-day requests, prefer local-day boundaries like 00:00:00.000 through 23:59:59.999.",
			"get_sessions: Results include sessionPath plus summaries/topics/filesModified; use those paths with session_query for deeper answers.",
			"get_sessions: Default sort is newest and default limit is 10. Use sort='best_match' when query relevance matters most.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Optional fuzzy keyword query over summaries, topics, and filesModified." })),
			from: Type.Optional(Type.String({ description: "Optional inclusive range start. Prefer explicit ISO timestamps. Date-only values are interpreted as the start of that local day." })),
			to: Type.Optional(Type.String({ description: "Optional inclusive range end. Prefer explicit ISO timestamps. Date-only values are interpreted as the end of that local day." })),
			sort: Type.Optional(Type.Union([
				Type.Literal("oldest"),
				Type.Literal("newest"),
				Type.Literal("best_match"),
			], { description: "Sort order. Defaults to newest." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GET_SESSIONS_LIMIT, description: `Maximum sessions to return. Defaults to ${DEFAULT_GET_SESSIONS_LIMIT}. Max ${MAX_GET_SESSIONS_LIMIT}.` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const sort = (params.sort as SessionSort | undefined) ?? "newest";
			const limit = Math.min(Math.max(params.limit ?? DEFAULT_GET_SESSIONS_LIMIT, 1), MAX_GET_SESSIONS_LIMIT);
			const fromMs = parseDateBoundary(params.from, "start");
			const toMs = parseDateBoundary(params.to, "end");
			if (params.from && fromMs === undefined) {
				return { content: [{ type: "text", text: `Invalid from timestamp: ${params.from}` }], details: {}, isError: true };
			}
			if (params.to && toMs === undefined) {
				return { content: [{ type: "text", text: `Invalid to timestamp: ${params.to}` }], details: {}, isError: true };
			}
			if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
				return { content: [{ type: "text", text: "Invalid range: from must be before or equal to to." }], details: {}, isError: true };
			}
			const query = params.query?.trim();
			const entries = dedupeSessionEntries(await loadSessionIndex())
				.map((entry) => ({ entry, score: query ? scoreSessionEntry(entry, query) : 0 }))
				.filter(({ entry, score }) => (!query || score > 0) && sessionOverlapsRange(entry, fromMs, toMs))
				.sort((a, b) => compareSessions(a, b, sort))
				.slice(0, limit)
				.map(({ entry }) => entry);
			return {
				content: [{ type: "text", text: formatSessionListResult(entries, { query, from: params.from, to: params.to, sort, limit }) }],
				details: { entries, query, from: params.from, to: params.to, sort, limit },
			};
		},
	});

	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description: "Query a previous Pi session for context, decisions, file changes, and implementation details. Use get_sessions first to find relevant session paths when needed.",
		promptSnippet: "Use this when you need details from a specific parent or earlier session.",
		promptGuidelines: [
			"session_query: Prefer specific questions (files changed, decisions, rationale, unresolved issues).",
			"session_query: Use get_sessions first when the user asks for sessions by date range, fuzzy topic search, or when you do not already know the correct sessionPath.",
			"session_query: If sessionPath is omitted, it will try to use **Parent session:** from the current thread before searching indexed sessions.",
			"session_query: After get_sessions returns candidates, pass the exact sessionPath into session_query for deep inspection.",
		],
		renderResult: (result, _options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const parsed = text.match(/\*\*Query:\*\* ([\s\S]+?)\n\*\*Session:\*\* ([^\n]+)\n\n---\n\n([\s\S]+)/);
			if (parsed) {
				const [, query, sessionPath, answer] = parsed;
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query.trim()), 0, 0));
				container.addChild(new Text(theme.bold("Session: ") + theme.fg("muted", sessionPath.trim()), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(answer.trim(), 0, 0, getMarkdownTheme()));
				return container;
			}
			container.addChild(new Text(theme.fg("toolOutput", text || "(no output)"), 0, 0));
			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.Optional(Type.String({ description: "Specific session file. If omitted, session_query will try the parent-session marker from the current thread before searching indexed sessions." })),
			question: Type.String({ description: "What to find in previous sessions" }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Subagent core unavailable." }], details: {}, isError: true };
			}
			const question = params.question?.trim();
			if (!question) return { content: [{ type: "text", text: "Missing question." }], details: {}, isError: true };
			const config = await loadConfig(ctx.cwd);
			const explicitPath = params.sessionPath ? normalizeSessionPath(params.sessionPath) : undefined;
			const inferredParent = findParentSessionPathFromCurrentBranch(ctx);
			if (explicitPath || inferredParent) {
				const sessionPath = resolveSessionPath(explicitPath || inferredParent!, ctx.cwd);
				onUpdate?.({ content: [{ type: "text", text: `Querying session: ${sessionPath}` }], details: { sessionPath, question } });
				const result = await answerQuestionFromSession(subagentCore, ctx, config, sessionPath, question);
				if (result.exitCode !== 0) {
					return { content: [{ type: "text", text: result.errorMessage ?? "Session query failed." }], details: { result }, isError: true };
				}
				return { content: [{ type: "text", text: `**Query:** ${question}\n**Session:** ${sessionPath}\n\n---\n\n${result.output}` }], details: { sessionPath, question, result } };
			}
			const index = dedupeSessionEntries(await loadSessionIndex());
			const matches = index
				.map((entry) => ({ entry, score: scoreSessionEntry(entry, question) }))
				.filter((item) => item.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 3);
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No indexed sessions matched that query." }], details: { matches: [] }, isError: true };
			}
			const answers = await Promise.all(matches.map(({ entry }) => answerQuestionFromSession(subagentCore!, ctx, config, entry.sessionPath, question)));
			const combined = matches.map(({ entry }, index) => `## ${entry.sessionPath}\n\n${answers[index]?.output ?? "No answer."}`).join("\n\n---\n\n");
			return { content: [{ type: "text", text: combined }], details: { matches, answers } };
		},
	});

	pi.registerCommand("sessions", {
		description: "Inspect indexed sessions: /sessions, /sessions search <query>, /sessions pending, /sessions sync, /sessions reindex <path>, /sessions reindex-all",
		handler: async (args, ctx) => handleSessionsCommand(args, ctx, subagentCore),
	});

	pi.registerCommand("session", {
		description: "Inspect indexed sessions: /session, /session search <query>, /session pending, /session sync, /session reindex <path>, /session reindex-all",
		handler: async (args, ctx) => handleSessionsCommand(args, ctx, subagentCore),
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const config = await loadConfig(ctx.cwd);
		if (config.sessions?.autoIndex === false) return;
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (!sessionPath) return;
		const branch = ctx.sessionManager.getBranch();
		const messageCount = branch.filter((entry) => entry.type === "message").length;
		if (messageCount < 3) return;
		await addPendingIndexEntry({ sessionPath, cwd: ctx.cwd, queuedAt: new Date().toISOString(), attempts: 0 });
		queueMicrotask(() => {
			void (async () => {
				const pending = { sessionPath, cwd: ctx.cwd, queuedAt: new Date().toISOString(), attempts: 0 };
				const ok = await runIndexAttempt(ctx, pending, config);
				if (!ok) return;
				const current = await loadPendingIndexEntries();
				await updatePendingIndexEntries(current.filter((entry) => entry.sessionPath !== sessionPath));
			})().catch(() => {
				// best-effort background indexing
			});
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		schedulePendingIndexDrain(ctx);
	});
}
