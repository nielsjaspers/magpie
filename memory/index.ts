import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { ensureAutodreamScheduled } from "../schedule/index.js";
import { parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import type { HostedSessionSnapshot, HostedSessionSummary } from "../runtime/session-host-types.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import {
	createInboxMemoryItem,
	ensureMemoryDirs,
	formatStoredFiles,
	getLocalDateParts,
	getMemoryRootDir,
	inspectMemoryPath,
	listMemoryFiles,
	moveInboxItemsToArchive,
	searchMemoryFiles,
	writeDailyDigest,
	writeDreamArchive,
	writeMemoryFile,
	writeReviewFile,
	writeTelegramArchive,
} from "./store.js";

function formatInspection(result: Awaited<ReturnType<typeof inspectMemoryPath>>) {
	if (result.kind === "directory") {
		return [`Directory: ${result.relativePath}`, "", ...result.entries.map((entry) => `- ${entry}`)].join("\n");
	}
	return `File: ${result.relativePath}\n\n${result.content}`;
}

function messageToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
		.filter(Boolean)
		.join("\n");
}

function sessionConversationText(ctx: any): string {
	const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
	return branch
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => {
			const role = entry.message?.role ?? "unknown";
			const text = messageToText(entry.message?.content).trim();
			return `## ${role}\n\n${text || "(no text)"}`;
		})
		.join("\n\n");
}

function snapshotConversationText(snapshot: HostedSessionSnapshot | undefined): string {
	if (!snapshot?.messages?.length) return "";
	return snapshot.messages
		.map((message) => `## ${message.role}\n\n${message.text?.trim() || "(no text)"}`)
		.join("\n\n");
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("```")) {
		const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced?.[1]) return fenced[1].trim();
	}
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
	return trimmed;
}

interface DreamPlan {
	digestMarkdown: string;
	archiveSummaryMarkdown: string;
	graphWrites: Array<{ path: string; content: string }>;
	reviewMarkdown?: string;
	processedInboxPaths?: string[];
	retainedInboxPaths?: string[];
}

function parseDreamPlan(text: string): DreamPlan {
	const parsed = JSON.parse(extractJsonObject(text)) as DreamPlan;
	if (!parsed.digestMarkdown?.trim()) throw new Error("Dream output missing digestMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream output missing archiveSummaryMarkdown.");
	if (!Array.isArray(parsed.graphWrites)) parsed.graphWrites = [];
	for (const item of parsed.graphWrites) {
		if (!item?.path?.trim() || !item.content?.trim()) throw new Error("Dream output contains an invalid graph write.");
		if (!item.path.startsWith("graph/")) throw new Error(`Dream graph write must stay under graph/: ${item.path}`);
	}
	return parsed;
}

async function getJson<T>(baseUrl: string, path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	const response = await fetch(url);
	const json = await response.json();
	if (!response.ok) throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`);
	return json as T;
}

async function queueTelegramReset(hostUrl: string, threadId: string) {
	setTimeout(() => {
		void fetch(new URL("/api/v1/assistant/reset", hostUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ channel: "telegram", threadId }),
		}).catch(() => {
			// best-effort reset after dream response is delivered
		});
	}, 1500);
}

async function resolveDreamTarget(hostUrl: string, explicitThreadId: string | undefined, currentSessionId: string | undefined) {
	if (explicitThreadId?.trim()) return { threadId: explicitThreadId.trim(), source: "explicit" as const };
	const parsedThread = typeof currentSessionId === "string" ? parseAssistantThreadKey(currentSessionId) : undefined;
	if (parsedThread?.channel === "telegram") return { threadId: parsedThread.threadId, source: "current-session" as const };
	const listed = await getJson<{ sessions: HostedSessionSummary[] }>(hostUrl, "/api/v1/sessions", {
		kind: "assistant",
		assistantChannel: "telegram",
		includeArchived: 0,
		limit: 10,
	});
	const target = listed.sessions
		.filter((session) => session.assistantThreadId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	if (!target?.assistantThreadId) throw new Error("No active Telegram assistant thread found.");
	return { threadId: target.assistantThreadId, source: "active-telegram" as const };
}

async function getAssistantSnapshot(hostUrl: string, threadId: string, limit = 200) {
	return await getJson<HostedSessionSnapshot>(hostUrl, "/api/v1/assistant/snapshot", {
		channel: "telegram",
		threadId,
		limit,
	});
}

async function getOpenSessionContext(hostUrl: string, excludeThreadId: string, limit = 3): Promise<string> {
	const listed = await getJson<{ sessions: HostedSessionSummary[] }>(hostUrl, "/api/v1/sessions", {
		includeArchived: 0,
		limit: 12,
	});
	const candidates = listed.sessions
		.filter((session) => session.sessionId && !(session.assistantChannel === "telegram" && session.assistantThreadId === excludeThreadId))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, limit);
	if (candidates.length === 0) return "Other open sessions: none";
	const sections: string[] = ["Other open sessions context"];
	for (const session of candidates) {
		try {
			const encoded = encodeURIComponent(session.sessionId);
			const snapshot = await getJson<HostedSessionSnapshot>(hostUrl, `/api/v1/sessions/${encoded}/snapshot`, { limit: 12 });
			sections.push(`## ${session.sessionId}\n\n${snapshotConversationText(snapshot).trim() || "(no text)"}`);
		} catch {
			sections.push(`## ${session.sessionId}\n\n(unavailable)`);
		}
	}
	return sections.join("\n\n");
}

const NIGHTLY_AUTODREAM_TASK = "[magpie:autodream] Run nightly autodream now. Use the dream tool to process the active Telegram thread, include other open sessions as context, write digest/review/graph artifacts, and reset the Telegram thread when done.";

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});
	pi.events.emit("magpie:subagent-core:get", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = await loadConfig(ctx.cwd);
		await ensureMemoryDirs(getMemoryRootDir(config.memory));
		try {
			await ensureAutodreamScheduled(ctx, {
				enabled: config.memory?.autodream?.enabled === true,
				schedule: config.memory?.autodream?.schedule,
				task: NIGHTLY_AUTODREAM_TASK,
				cwd: ctx.cwd,
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Autodream scheduling failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand("remember", {
		description: "Capture a memory candidate into the memory inbox: /remember <text>",
		handler: async (args, ctx) => {
			const content = args?.trim();
			if (!content) {
				ctx.ui.notify("Usage: /remember <text>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const item = await createInboxMemoryItem(getMemoryRootDir(config.memory), { content });
			ctx.ui.notify(`Captured memory in ${item.relativePath}`, "info");
		},
	});

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: "Capture a memory candidate into the memory inbox for later dream-time organization.",
		promptSnippet: "Capture a memory candidate into the memory inbox for later organization.",
		parameters: Type.Object({
			content: Type.String({ description: "What to remember" }),
			title: Type.Optional(Type.String({ description: "Optional short title for the inbox item" })),
			tags: Type.Optional(Type.Array(Type.String({ description: "Optional tag" }), { description: "Optional tags for the inbox item" })),
			source: Type.Optional(Type.String({ description: "Optional source label, e.g. telegram, email, calendar" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const item = await createInboxMemoryItem(getMemoryRootDir(config.memory), params);
			return {
				content: [{ type: "text", text: `Captured memory in ${item.relativePath}` }],
				details: item,
			};
		},
	});

	pi.registerTool({
		name: "read_memory",
		label: "Read Memory",
		description: "Inspect raw memory files or directories under the memory root.",
		promptSnippet: "Inspect raw memory files or directories under the memory root.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Relative path under memory.rootDir. Omit to inspect the root." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const config = await loadConfig(ctx.cwd);
				const result = await inspectMemoryPath(getMemoryRootDir(config.memory), params.path?.trim() || ".");
				return { content: [{ type: "text", text: formatInspection(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "write_memory",
		label: "Write Memory",
		description: "Write or append a file under the memory root for explicit manual memory maintenance.",
		promptSnippet: "Write or append a file under the memory root for explicit manual memory maintenance.",
		parameters: Type.Object({
			path: Type.String({ description: "Relative path under memory.rootDir" }),
			content: Type.String({ description: "File content to write" }),
			append: Type.Optional(Type.Boolean({ description: "Append instead of overwrite" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const config = await loadConfig(ctx.cwd);
				const result = await writeMemoryFile(getMemoryRootDir(config.memory), params.path.trim(), params.content, { append: params.append });
				return { content: [{ type: "text", text: `Wrote ${result.relativePath}` }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "recall_memory",
		label: "Recall Memory",
		description: "Retrieve synthesized memory context from the inbox/graph/archive/review system, with file references.",
		promptSnippet: "Retrieve synthesized memory context from the memory system, with file references.",
		parameters: Type.Object({
			query: Type.String({ description: "What to recall from memory" }),
			limit: Type.Optional(Type.Integer({ description: "Maximum files to retrieve before synthesis (default 8, max 20).", minimum: 1, maximum: 20 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Memory subagent unavailable." }], details: {}, isError: true };
			}
			const config = await loadConfig(ctx.cwd);
			const rootDir = getMemoryRootDir(config.memory);
			const matches = await searchMemoryFiles(rootDir, params.query.trim(), Math.min(params.limit ?? 8, 20));
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matching memory files." }], details: { matches: [] } };
			}
			const result = await subagentCore.runSubagent(ctx, config, {
				role: "memory",
				label: "recall-memory",
				task: [
					"Answer the memory query using the provided memory materials.",
					"Return a concise synthesized answer followed by a References section that names the relevant file paths.",
					`Memory query: ${params.query.trim()}`,
					"Memory materials:",
					...matches.map((match) => `## ${match.relativePath}\n\n${match.content.trim()}`),
				].join("\n\n"),
				tools: [],
				timeout: 180000,
			});
			if (result.exitCode !== 0) {
				return { content: [{ type: "text", text: result.errorMessage || "Memory recall failed." }], details: { matches, result }, isError: true };
			}
			return {
				content: [{ type: "text", text: result.output.trim() }],
				details: { matches: matches.map((match) => ({ relativePath: match.relativePath, score: match.score })) },
			};
		},
	});

	pi.registerTool({
		name: "dream",
		label: "Dream",
		description: "Trigger the dream flow: archive the Telegram thread, consolidate memory, write digest/review/graph updates, and optionally reset the Telegram thread.",
		promptSnippet: "Trigger the dream flow.",
		parameters: Type.Object({
			note: Type.Optional(Type.String({ description: "Optional note about what this dream run should focus on" })),
			threadId: Type.Optional(Type.String({ description: "Optional Telegram threadId. Omit to use the current Telegram thread or the most recently active Telegram thread." })),
			resetThread: Type.Optional(Type.Boolean({ description: "Whether to reset the Telegram thread after dreaming. Defaults to true." })),
			includeOpenSessions: Type.Optional(Type.Boolean({ description: "Whether to include other open sessions as context. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Memory subagent unavailable." }], details: {}, isError: true };
			}

			const config = await loadConfig(ctx.cwd);
			const rootDir = getMemoryRootDir(config.memory);
			await ensureMemoryDirs(rootDir);
			const hostUrl = config.telegram?.hostUrl?.trim() || "http://127.0.0.1:8787";
			const resetThread = params.resetThread !== false;
			const includeOpenSessions = params.includeOpenSessions !== false;
			const currentSessionId = (ctx.sessionManager as any).getSessionId?.();

			let target;
			try {
				target = await resolveDreamTarget(hostUrl, params.threadId, currentSessionId);
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
			}

			let telegramSnapshot: HostedSessionSnapshot | undefined;
			try {
				telegramSnapshot = await getAssistantSnapshot(hostUrl, target.threadId, 250);
			} catch (error) {
				if (target.source !== "current-session") {
					return {
						content: [{ type: "text", text: `Failed to load Telegram thread snapshot: ${error instanceof Error ? error.message : String(error)}` }],
						details: { threadId: target.threadId },
						isError: true,
					};
				}
			}

			const timezone = config.personalAssistant?.timezone?.trim() || "Europe/Amsterdam";
			const now = new Date();
			const { dayStamp, timestampStamp } = getLocalDateParts(now, timezone);
			const transcript = snapshotConversationText(telegramSnapshot) || sessionConversationText(ctx);
			const inboxFiles = await listMemoryFiles(rootDir, "inbox", { recursive: true, extensions: [".md", ".json", ".txt"] });
			const recentReviewFiles = await listMemoryFiles(rootDir, "review", { recursive: false, extensions: [".md"] });
			const graphContextFiles = await searchMemoryFiles(rootDir, params.note?.trim() || transcript.slice(0, 800), 10);
			const openSessionContext = includeOpenSessions ? await getOpenSessionContext(hostUrl, target.threadId, 3) : "Other open sessions: omitted";

			const dreamPrompt = [
				"Run a memory dream pass.",
				"Return exactly one JSON object with these fields:",
				"- digestMarkdown: string (user-facing digest for Telegram and digest/daily/<day>.md)",
				"- archiveSummaryMarkdown: string (internal archive summary for this dream run)",
				"- graphWrites: Array<{ path: string, content: string }> where every path stays under graph/",
				"- reviewMarkdown?: string (only when review clarification is needed)",
				"- processedInboxPaths?: string[] (relative inbox paths fully processed and safe to archive out of inbox)",
				"- retainedInboxPaths?: string[] (relative inbox paths that should stay in inbox for later)",
				"Prefer coherent graph updates over excessive file proliferation.",
				"If there is no necessary graph update, return an empty graphWrites array.",
				"Do not include Markdown fences.",
				params.note?.trim() ? `Dream focus note: ${params.note.trim()}` : undefined,
				`Local timezone: ${timezone}`,
				`Current local day: ${dayStamp}`,
				`Target Telegram thread: ${target.threadId}`,
				`Dream target source: ${target.source}`,
				formatStoredFiles(inboxFiles, "Inbox items"),
				formatStoredFiles(recentReviewFiles.slice(-3), "Recent review files"),
				graphContextFiles.length
					? ["Relevant graph/archive context", ...graphContextFiles.map((file) => `## ${file.relativePath}\n\n${file.content.trim()}`)].join("\n\n")
					: "Relevant graph/archive context: none",
				openSessionContext,
				"Current Telegram transcript:",
				transcript || "(empty transcript)",
			].filter(Boolean).join("\n\n");

			const dreamResult = await subagentCore.runSubagent(ctx, config, {
				role: "memory",
				label: "dream",
				task: dreamPrompt,
				tools: [],
				timeout: 240000,
			});
			if (dreamResult.exitCode !== 0 || !dreamResult.output.trim()) {
				return {
					content: [{ type: "text", text: dreamResult.errorMessage || "Dream failed." }],
					details: { result: dreamResult },
					isError: true,
				};
			}

			let plan: DreamPlan;
			try {
				plan = parseDreamPlan(dreamResult.output);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
					details: { output: dreamResult.output },
					isError: true,
				};
			}

			const graphWrites = [] as Array<{ path: string; absolutePath: string; relativePath: string }>;
			for (const write of plan.graphWrites) {
				graphWrites.push(await writeMemoryFile(rootDir, write.path, write.content));
			}

			const digestFile = await writeDailyDigest(rootDir, dayStamp, plan.digestMarkdown);
			const reviewFile = plan.reviewMarkdown?.trim() ? await writeReviewFile(rootDir, dayStamp, plan.reviewMarkdown.trim()) : undefined;
			const telegramArchive = await writeTelegramArchive(rootDir, timestampStamp, [
				`# Telegram Transcript Archive`,
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- threadId: ${target.threadId}`,
				`- source: ${target.source}`,
				"",
				transcript || "(empty transcript)",
			].join("\n"));
			const dreamArchive = await writeDreamArchive(rootDir, timestampStamp, [
				`# Dream Run`,
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- timezone: ${timezone}`,
				`- day: ${dayStamp}`,
				`- threadId: ${target.threadId}`,
				params.note?.trim() ? `- note: ${params.note.trim()}` : undefined,
				"",
				`## Archive Summary`,
				"",
				plan.archiveSummaryMarkdown.trim(),
				"",
				`## Digest`,
				"",
				plan.digestMarkdown.trim(),
				plan.reviewMarkdown?.trim() ? `\n## Review\n\n${plan.reviewMarkdown.trim()}` : undefined,
			].filter(Boolean).join("\n"));

			const processedInbox = Array.isArray(plan.processedInboxPaths)
				? plan.processedInboxPaths.filter((value) => typeof value === "string" && value.startsWith("inbox/"))
				: [];
			const archivedInbox = await moveInboxItemsToArchive(rootDir, processedInbox, timestampStamp);

			if (resetThread) await queueTelegramReset(hostUrl, target.threadId);

			const summaryLines = [
				"Dream complete.",
				"",
				plan.digestMarkdown.trim(),
				"",
				"Artifacts:",
				`- digest: ${digestFile.relativePath}`,
				reviewFile ? `- review: ${reviewFile.relativePath}` : undefined,
				`- telegram archive: ${telegramArchive.relativePath}`,
				`- dream archive: ${dreamArchive.relativePath}`,
				...graphWrites.map((file) => `- graph: ${file.relativePath}`),
				...archivedInbox.map((file) => `- archived inbox: ${file.to}`),
				resetThread ? "Telegram thread reset has been queued." : "Telegram thread reset skipped.",
			].filter(Boolean);

			return {
				content: [{ type: "text", text: summaryLines.join("\n") }],
				details: {
					dayStamp,
					timestampStamp,
					threadId: target.threadId,
					targetSource: target.source,
					digestFile,
					reviewFile,
					telegramArchive,
					dreamArchive,
					graphWrites,
					archivedInbox,
				},
			};
		},
	});
}
