import { existsSync } from "node:fs";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";
import { addPendingIndexEntry, loadPendingIndexEntries, loadSessionIndex, scoreSessionEntry, updatePendingIndexEntries, upsertIndexEntry } from "./indexer.js";
import type { PendingIndexEntry } from "./types.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { handleSessionsCommand } from "./commands.js";
import { compareSessions, dedupeSessionEntries, formatSessionListResult, sessionOverlapsRange, type SessionSort } from "./format.js";
import { answerQuestionFromSession, summarizeSession } from "./indexing.js";
import { findParentSessionPathFromCurrentBranch, normalizeSessionPath, parseDateBoundary, resolveSessionPath } from "./parse.js";

const MAX_GET_SESSIONS_LIMIT = 50;
const DEFAULT_GET_SESSIONS_LIMIT = 10;

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
