import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { convertToLlm, getMarkdownTheme, SessionManager, serializeConversation, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { addPendingIndexEntry, appendIndexEntry, loadPendingIndexEntries, loadSessionIndex, scoreSessionEntry, updatePendingIndexEntries } from "./indexer.js";
import type { PendingIndexEntry, SessionIndexEntry } from "./types.js";
import type { SubagentCoreAPI } from "../subagents/types.js";

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
	const manager = SessionManager.open(sessionPath);
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
	let parsed: { summary?: string; topics?: string[]; filesModified?: string[] } | undefined;
	try {
		parsed = JSON.parse(result.output.trim());
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
	return {
		sessionId: manager.getSessionId(),
		sessionPath,
		startedAt: branch[0]?.timestamp ? new Date(branch[0].timestamp).toISOString() : new Date().toISOString(),
		endedAt: new Date().toISOString(),
		cwd,
		messageCount: messages.length,
		modelsUsed,
		summary: parsed.summary ?? "",
		topics: Array.isArray(parsed.topics) ? parsed.topics : [],
		filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified : [],
	};
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});
	pi.events.emit("magpie:subagent-core:get", (api: SubagentCoreAPI) => {
		subagentCore = api;
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
		await appendIndexEntry(entry, config.sessions?.maxIndexEntries ?? 500);
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
		name: "session_query",
		label: "Session Query",
		description: "Query a previous Pi session for context, decisions, file changes, and implementation details.",
		promptSnippet: "Use this when you need details from a parent or earlier session.",
		promptGuidelines: [
			"Prefer specific questions (files changed, decisions, rationale, unresolved issues).",
			"If sessionPath is omitted, it will try to use **Parent session:** from the current thread.",
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
			sessionPath: Type.Optional(Type.String({ description: "Specific session file. If omitted, searches the index first." })),
			question: Type.String({ description: "What to find in previous sessions" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Subagent core unavailable." }], details: {}, isError: true };
			}
			const question = params.question?.trim();
			if (!question) return { content: [{ type: "text", text: "Missing question." }], details: {}, isError: true };
			const config = await loadConfig(ctx.cwd);
			const explicitPath = params.sessionPath ? normalizeSessionPath(params.sessionPath) : undefined;
			if (explicitPath || findParentSessionPathFromCurrentBranch(ctx)) {
				const sessionPath = resolveSessionPath(explicitPath || findParentSessionPathFromCurrentBranch(ctx)!, ctx.cwd);
				onUpdate?.({ content: [{ type: "text", text: `Querying session: ${sessionPath}` }], details: { sessionPath, question } });
				const result = await answerQuestionFromSession(subagentCore, ctx, config, sessionPath, question);
				if (result.exitCode !== 0) {
					return { content: [{ type: "text", text: result.errorMessage ?? "Session query failed." }], details: { result }, isError: true };
				}
				return { content: [{ type: "text", text: `**Query:** ${question}\n**Session:** ${sessionPath}\n\n---\n\n${result.output}` }], details: { sessionPath, question, result } };
			}
			const index = await loadSessionIndex();
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
		description: "Inspect indexed sessions: /sessions, /sessions search <query>, /sessions pending, /sessions reindex <path>",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			if (!raw) {
				const recent = (await loadSessionIndex()).slice(-10).reverse();
				ctx.ui.notify(recent.length ? recent.map((entry) => `${entry.endedAt}  ${entry.summary}`).join("\n") : "No indexed sessions yet.", "info");
				return;
			}
			if (raw.startsWith("search ")) {
				const query = raw.slice("search ".length).trim();
				const results = (await loadSessionIndex())
					.map((entry) => ({ entry, score: scoreSessionEntry(entry, query) }))
					.filter((item) => item.score > 0)
					.sort((a, b) => b.score - a.score)
					.slice(0, 10);
				ctx.ui.notify(results.length ? results.map(({ entry }) => `${entry.sessionPath}\n- ${entry.summary}`).join("\n\n") : "No matches.", "info");
				return;
			}
			if (raw === "pending") {
				const pending = await loadPendingIndexEntries();
				ctx.ui.notify(pending.length ? pending.map((entry) => `${entry.sessionPath} (attempts: ${entry.attempts})`).join("\n") : "No pending entries.", "info");
				return;
			}
			if (raw.startsWith("reindex ")) {
				if (!subagentCore) {
					ctx.ui.notify("Subagent core unavailable.", "error");
					return;
				}
				const sessionPath = raw.slice("reindex ".length).trim();
				const config = await loadConfig(ctx.cwd);
				const entry = await summarizeSession(subagentCore, ctx, config, sessionPath, ctx.cwd);
				if (!entry) {
					ctx.ui.notify("Failed to index session.", "error");
					return;
				}
				await appendIndexEntry(entry, config.sessions?.maxIndexEntries ?? 500);
				ctx.ui.notify(`Indexed ${sessionPath}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /sessions, /sessions search <query>, /sessions pending, /sessions reindex <path>", "warning");
		},
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
