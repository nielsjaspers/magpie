import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config/config.js";
import { ensureAutodreamScheduled } from "../schedule/index.js";
import { parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import type { HostedSessionSnapshot, HostedSessionSummary } from "../runtime/session-host-types.js";
import type { PaCalendarEvent, PaEmailSummary } from "../pa/shared/types.js";
import { createCalendarEventForContext } from "../pa/calendar/index.js";
import { searchEmailSummariesForContext } from "../pa/mail/index.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import {
	createInboxMemoryItem,
	ensureMemoryDirs,
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

const DREAM_TRANSCRIPT_CHAR_LIMIT = 12000;
const DREAM_FILE_CHAR_LIMIT = 4000;
const DREAM_OPEN_SESSION_CHAR_LIMIT = 6000;
const DREAM_MAX_INBOX_FILES = 8;
const DREAM_MAX_GRAPH_FILES = 6;
const DREAM_MAX_REVIEW_FILES = 2;

function truncateForPrompt(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}\n\n… (truncated ${trimmed.length - maxChars} chars)`;
}

function snapshotConversationText(snapshot: HostedSessionSnapshot | undefined): string {
	if (!snapshot?.messages?.length) return "";
	return snapshot.messages
		.map((message) => `## ${message.role}\n\n${message.text?.trim() || "(no text)"}`)
		.join("\n\n");
}

function formatPromptFiles(
	files: Array<{ relativePath: string; content: string }>,
	heading: string,
	maxCharsPerFile: number,
	maxFiles?: number,
): string {
	const limited = typeof maxFiles === "number" ? files.slice(0, maxFiles) : files;
	if (limited.length === 0) return `${heading}: none`;
	return [heading, ...limited.map((file) => `## ${file.relativePath}\n\n${truncateForPrompt(file.content, maxCharsPerFile)}`)].join("\n\n");
}

function formatEmailSummaries(emails: PaEmailSummary[]): string {
	if (emails.length === 0) return "Recent email (last 2 days): none";
	return [
		"Recent email (last 2 days)",
		...emails.map((message) => [
			`- id=${message.id}`,
			`thread=${message.threadId}`,
			message.date,
			message.from,
			message.subject,
			message.snippet ? `| ${message.snippet}` : undefined,
		].filter(Boolean).join(" | ")),
	].join("\n");
}

function extractBalancedJsonObject(text: string): string | undefined {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (start < 0) start = i;
			depth += 1;
			continue;
		}
		if (ch === "}") {
			if (depth > 0) depth -= 1;
			if (start >= 0 && depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		const balanced = extractBalancedJsonObject(fenced[1]);
		return balanced?.trim() || fenced[1].trim();
	}
	const balanced = extractBalancedJsonObject(trimmed);
	if (balanced?.trim()) return balanced.trim();
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

interface DreamCalendarEventCandidate {
	summary: string;
	start: string;
	end: string;
	location?: string;
	description?: string;
	allDay?: boolean;
	calendarId?: string;
	rationale?: string;
}

interface DreamPhase1Plan {
	archiveSummaryMarkdown: string;
	consolidatedFindingsMarkdown: string;
	candidateGraphQueries: string[];
	processedInboxPaths?: string[];
	retainedInboxPaths?: string[];
	candidateCalendarEvents?: DreamCalendarEventCandidate[];
}

interface DreamPhase2Plan {
	archiveSummaryMarkdown: string;
	memoryLinkingMarkdown: string;
	graphWrites: Array<{ path: string; content: string }>;
	candidateCalendarEvents?: DreamCalendarEventCandidate[];
}

interface DreamPhase3Plan {
	digestMarkdown: string;
	archiveSummaryMarkdown: string;
	reviewMarkdown?: string;
	calendarEvents?: DreamCalendarEventCandidate[];
}

function normalizeCalendarEventCandidates(items: unknown): DreamCalendarEventCandidate[] {
	if (!Array.isArray(items)) return [];
	return items
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			summary: typeof item.summary === "string" ? item.summary.trim() : "",
			start: typeof item.start === "string" ? item.start.trim() : "",
			end: typeof item.end === "string" ? item.end.trim() : "",
			location: typeof item.location === "string" ? item.location.trim() : undefined,
			description: typeof item.description === "string" ? item.description.trim() : undefined,
			allDay: typeof item.allDay === "boolean" ? item.allDay : undefined,
			calendarId: typeof item.calendarId === "string" ? item.calendarId.trim() : undefined,
			rationale: typeof item.rationale === "string" ? item.rationale.trim() : undefined,
		}))
		.filter((item) => item.summary && item.start && item.end);
}

function validateDreamPlan(parsed: DreamPlan): DreamPlan {
	if (!parsed.digestMarkdown?.trim()) throw new Error("Dream output missing digestMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream output missing archiveSummaryMarkdown.");
	if (!Array.isArray(parsed.graphWrites)) parsed.graphWrites = [];
	for (const item of parsed.graphWrites) {
		if (!item?.path?.trim() || !item.content?.trim()) throw new Error("Dream output contains an invalid graph write.");
		if (!item.path.startsWith("graph/")) throw new Error(`Dream graph write must stay under graph/: ${item.path}`);
	}
	return parsed;
}

function validatePhase1Plan(parsed: DreamPhase1Plan): DreamPhase1Plan {
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream phase 1 output missing archiveSummaryMarkdown.");
	if (!parsed.consolidatedFindingsMarkdown?.trim()) throw new Error("Dream phase 1 output missing consolidatedFindingsMarkdown.");
	parsed.candidateGraphQueries = Array.isArray(parsed.candidateGraphQueries)
		? parsed.candidateGraphQueries.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 12)
		: [];
	parsed.processedInboxPaths = Array.isArray(parsed.processedInboxPaths)
		? parsed.processedInboxPaths.filter((value): value is string => typeof value === "string" && value.startsWith("inbox/"))
		: [];
	parsed.retainedInboxPaths = Array.isArray(parsed.retainedInboxPaths)
		? parsed.retainedInboxPaths.filter((value): value is string => typeof value === "string" && value.startsWith("inbox/"))
		: [];
	parsed.candidateCalendarEvents = normalizeCalendarEventCandidates(parsed.candidateCalendarEvents);
	return parsed;
}

function validatePhase2Plan(parsed: DreamPhase2Plan): DreamPhase2Plan {
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream phase 2 output missing archiveSummaryMarkdown.");
	if (!parsed.memoryLinkingMarkdown?.trim()) throw new Error("Dream phase 2 output missing memoryLinkingMarkdown.");
	if (!Array.isArray(parsed.graphWrites)) parsed.graphWrites = [];
	for (const item of parsed.graphWrites) {
		if (!item?.path?.trim() || !item.content?.trim()) throw new Error("Dream phase 2 output contains an invalid graph write.");
		if (!item.path.startsWith("graph/")) throw new Error(`Dream phase 2 graph write must stay under graph/: ${item.path}`);
	}
	parsed.candidateCalendarEvents = normalizeCalendarEventCandidates(parsed.candidateCalendarEvents);
	return parsed;
}

function validatePhase3Plan(parsed: DreamPhase3Plan): DreamPhase3Plan {
	if (!parsed.digestMarkdown?.trim()) throw new Error("Dream phase 3 output missing digestMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream phase 3 output missing archiveSummaryMarkdown.");
	parsed.calendarEvents = normalizeCalendarEventCandidates(parsed.calendarEvents);
	return parsed;
}

function parseDreamPlanFromSections(text: string): DreamPlan | undefined {
	const trimmed = text.trim();
	const digestMatch = trimmed.match(/(?:^|\n)##\s*digestMarkdown\s*\n([\s\S]*?)(?=\n##\s+[A-Za-z]|$)/i);
	const archiveMatch = trimmed.match(/(?:^|\n)##\s*archiveSummaryMarkdown\s*\n([\s\S]*?)(?=\n##\s+[A-Za-z]|$)/i);
	const graphMatch = trimmed.match(/(?:^|\n)##\s*graphWrites\s*\n([\s\S]*?)(?=\n##\s+[A-Za-z]|$)/i);
	const reviewMatch = trimmed.match(/(?:^|\n)##\s*reviewMarkdown\s*\n([\s\S]*?)(?=\n##\s+[A-Za-z]|$)/i);
	if (!digestMatch?.[1] || !archiveMatch?.[1]) return undefined;
	let graphWrites: DreamPlan["graphWrites"] = [];
	const graphText = graphMatch?.[1]?.trim();
	if (graphText) {
		const parsedGraph = JSON.parse(extractJsonObject(graphText));
		graphWrites = Array.isArray(parsedGraph) ? parsedGraph : [];
	}
	return validateDreamPlan({
		digestMarkdown: digestMatch[1].trim(),
		archiveSummaryMarkdown: archiveMatch[1].trim(),
		graphWrites,
		reviewMarkdown: reviewMatch?.[1]?.trim() || undefined,
	});
}

function parseDreamPlan(text: string): DreamPlan {
	try {
		return validateDreamPlan(JSON.parse(extractJsonObject(text)) as DreamPlan);
	} catch (jsonError) {
		const sectionParsed = parseDreamPlanFromSections(text);
		if (sectionParsed) return sectionParsed;
		throw jsonError;
	}
}

function parseStructuredJson<T>(text: string, validator: (parsed: T) => T): T {
	return validator(JSON.parse(extractJsonObject(text)) as T);
}

async function runDreamPhase<T>(
	ctx: any,
	config: any,
	subagentCore: SubagentCoreAPI,
	phaseLabel: string,
	task: string,
	validator: (parsed: T) => T,
): Promise<T> {
	const result = await subagentCore.runSubagent(ctx, config, {
		role: "memory",
		label: phaseLabel,
		task,
		tools: [],
		timeout: 240000,
	});
	if (result.exitCode !== 0 || !result.output.trim()) throw new Error(result.errorMessage || `${phaseLabel} failed.`);
	try {
		return parseStructuredJson(result.output, validator);
	} catch (error) {
		const repaired = await subagentCore.runSubagent(ctx, config, {
			role: "custom",
			label: `${phaseLabel}-json-repair`,
			task: [
				`Repair this malformed ${phaseLabel} output into valid JSON.`,
				"Return exactly one valid JSON object and nothing else.",
				`Original parse error: ${error instanceof Error ? error.message : String(error)}`,
				"Malformed output:",
				result.output,
			].join("\n\n"),
			tools: [],
			timeout: 120000,
		});
		if (repaired.exitCode !== 0 || !repaired.output.trim()) throw new Error(repaired.errorMessage || `${phaseLabel} JSON repair failed.`);
		return parseStructuredJson(repaired.output, validator);
	}
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
			const snapshot = await getJson<HostedSessionSnapshot>(hostUrl, `/api/v1/sessions/${encoded}/snapshot`, { limit: 8 });
			sections.push(`## ${session.sessionId}\n\n${truncateForPrompt(snapshotConversationText(snapshot).trim() || "(no text)", DREAM_OPEN_SESSION_CHAR_LIMIT)}`);
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
			const transcript = truncateForPrompt(snapshotConversationText(telegramSnapshot) || sessionConversationText(ctx), DREAM_TRANSCRIPT_CHAR_LIMIT);
			const inboxFiles = await listMemoryFiles(rootDir, "inbox", { recursive: true, extensions: [".md", ".json", ".txt"] });
			const recentReviewFiles = (await listMemoryFiles(rootDir, "review", { recursive: false, extensions: [".md"] })).slice(-DREAM_MAX_REVIEW_FILES);
			const openSessionContext = includeOpenSessions ? await getOpenSessionContext(hostUrl, target.threadId, 2) : "Other open sessions: omitted";
			let recentEmails: PaEmailSummary[] = [];
			let emailError: string | undefined;
			try {
				recentEmails = await searchEmailSummariesForContext(ctx, { sinceDays: 2, limit: 20 });
			} catch (error) {
				emailError = error instanceof Error ? error.message : String(error);
			}

			let phase1: DreamPhase1Plan;
			try {
				phase1 = await runDreamPhase<DreamPhase1Plan>(ctx, config, subagentCore, "dream-phase-1", [
					"Run dream phase 1: intake and consolidation.",
					"Goal: read the new inbox/transcript/email inputs, normalize them, decide what is important, decide which inbox items are processed vs retained, and propose concrete candidate graph queries and candidate calendar events.",
					"Return exactly one JSON object with these fields:",
					"- archiveSummaryMarkdown: string",
					"- consolidatedFindingsMarkdown: string",
					"- candidateGraphQueries: string[]",
					"- processedInboxPaths?: string[]",
					"- retainedInboxPaths?: string[]",
					"- candidateCalendarEvents?: Array<{ summary, start, end, location?, description?, allDay?, calendarId?, rationale? }>",
					"Prefer concrete, inspectable findings. Calendar candidates should only be included when the event is specific enough to create.",
					"Do not include Markdown fences.",
					params.note?.trim() ? `Dream focus note: ${params.note.trim()}` : undefined,
					`Local timezone: ${timezone}`,
					`Current local day: ${dayStamp}`,
					`Target Telegram thread: ${target.threadId}`,
					`Dream target source: ${target.source}`,
					formatPromptFiles(inboxFiles, "Inbox items", DREAM_FILE_CHAR_LIMIT),
					formatPromptFiles(recentReviewFiles, "Recent review files", DREAM_FILE_CHAR_LIMIT, DREAM_MAX_REVIEW_FILES),
					formatEmailSummaries(recentEmails),
					emailError ? `Recent email intake error: ${emailError}` : undefined,
					openSessionContext,
					"Current Telegram transcript:",
					transcript || "(empty transcript)",
				].filter(Boolean).join("\n\n"), validatePhase1Plan);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 1 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId },
					isError: true,
				};
			}

			const graphQuery = [params.note?.trim(), ...phase1.candidateGraphQueries].filter(Boolean).join(" ").trim();
			const graphContextFiles = graphQuery ? await searchMemoryFiles(rootDir, graphQuery, 12) : [];
			let phase2: DreamPhase2Plan;
			try {
				phase2 = await runDreamPhase<DreamPhase2Plan>(ctx, config, subagentCore, "dream-phase-2", [
					"Run dream phase 2: graph linking and memory integration.",
					"Goal: use the phase 1 findings plus relevant existing graph/archive context to produce coherent graph writes and refine event candidates if needed.",
					"Return exactly one JSON object with these fields:",
					"- archiveSummaryMarkdown: string",
					"- memoryLinkingMarkdown: string",
					"- graphWrites: Array<{ path: string, content: string }> where every path stays under graph/",
					"- candidateCalendarEvents?: Array<{ summary, start, end, location?, description?, allDay?, calendarId?, rationale? }>",
					"Prefer updating existing graph files over creating many new ones.",
					"Do not include Markdown fences.",
					`Phase 1 archive summary:\n\n${phase1.archiveSummaryMarkdown}`,
					`Phase 1 consolidated findings:\n\n${phase1.consolidatedFindingsMarkdown}`,
					phase1.candidateCalendarEvents?.length ? `Phase 1 calendar candidates:\n\n${JSON.stringify(phase1.candidateCalendarEvents, null, 2)}` : "Phase 1 calendar candidates: none",
					graphContextFiles.length
						? formatPromptFiles(graphContextFiles, "Relevant graph/archive context", DREAM_FILE_CHAR_LIMIT, 12)
						: "Relevant graph/archive context: none",
				].join("\n\n"), validatePhase2Plan);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 2 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, phase1 },
					isError: true,
				};
			}

			let phase3: DreamPhase3Plan;
			try {
				phase3 = await runDreamPhase<DreamPhase3Plan>(ctx, config, subagentCore, "dream-phase-3", [
					"Run dream phase 3: digest, review, and concrete event execution planning.",
					"Goal: produce the user-facing digest, any needed review note, and concrete calendar events that should actually be created now.",
					"Return exactly one JSON object with these fields:",
					"- digestMarkdown: string",
					"- archiveSummaryMarkdown: string",
					"- reviewMarkdown?: string",
					"- calendarEvents?: Array<{ summary, start, end, location?, description?, allDay?, calendarId?, rationale? }>",
					"Only include calendarEvents when they are concrete enough to create immediately.",
					"Do not include Markdown fences.",
					`Phase 1 archive summary:\n\n${phase1.archiveSummaryMarkdown}`,
					`Phase 1 consolidated findings:\n\n${phase1.consolidatedFindingsMarkdown}`,
					`Phase 2 archive summary:\n\n${phase2.archiveSummaryMarkdown}`,
					`Phase 2 memory linking:\n\n${phase2.memoryLinkingMarkdown}`,
					phase2.candidateCalendarEvents?.length ? `Phase 2 calendar candidates:\n\n${JSON.stringify(phase2.candidateCalendarEvents, null, 2)}` : "Phase 2 calendar candidates: none",
				].join("\n\n"), validatePhase3Plan);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 3 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, phase1, phase2 },
					isError: true,
				};
			}

			const graphWrites = [] as Array<{ path: string; absolutePath: string; relativePath: string }>;
			for (const write of phase2.graphWrites) {
				graphWrites.push(await writeMemoryFile(rootDir, write.path, write.content));
			}

			const createdEvents: Array<{ event: PaCalendarEvent; targetCalendar: { id: string; name: string }; rationale?: string }> = [];
			const calendarErrors: string[] = [];
			for (const candidate of phase3.calendarEvents ?? []) {
				try {
					const created = await createCalendarEventForContext(ctx, candidate);
					createdEvents.push({ ...created, rationale: candidate.rationale });
				} catch (error) {
					calendarErrors.push(`${candidate.summary}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			const digestBody = [
				phase3.digestMarkdown.trim(),
				createdEvents.length > 0
					? ["", "## Calendar events created", "", ...createdEvents.map(({ event, targetCalendar, rationale }) => `- ${event.summary} | ${event.start} → ${event.end} | ${targetCalendar.name}${rationale ? ` | ${rationale}` : ""}`)].join("\n")
					: undefined,
				calendarErrors.length > 0
					? ["", "## Calendar event creation errors", "", ...calendarErrors.map((line) => `- ${line}`)].join("\n")
					: undefined,
			].filter(Boolean).join("\n");
			const reviewBody = [
				phase3.reviewMarkdown?.trim(),
				calendarErrors.length > 0
					? ["## Calendar follow-up", "", ...calendarErrors.map((line) => `- ${line}`)].join("\n")
					: undefined,
			].filter(Boolean).join("\n\n");

			const digestFile = await writeDailyDigest(rootDir, dayStamp, digestBody);
			const reviewFile = reviewBody.trim() ? await writeReviewFile(rootDir, dayStamp, reviewBody.trim()) : undefined;
			const telegramArchive = await writeTelegramArchive(rootDir, timestampStamp, [
				`# Telegram Transcript Archive`,
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- threadId: ${target.threadId}`,
				`- source: ${target.source}`,
				"",
				transcript || "(empty transcript)",
			].join("\n"));
			await writeMemoryFile(rootDir, `archive/dreams/${timestampStamp}/phase1.json`, `${JSON.stringify(phase1, null, 2)}\n`);
			await writeMemoryFile(rootDir, `archive/dreams/${timestampStamp}/phase2.json`, `${JSON.stringify(phase2, null, 2)}\n`);
			await writeMemoryFile(rootDir, `archive/dreams/${timestampStamp}/phase3.json`, `${JSON.stringify(phase3, null, 2)}\n`);
			const dreamArchive = await writeDreamArchive(rootDir, timestampStamp, [
				`# Dream Run`,
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- timezone: ${timezone}`,
				`- day: ${dayStamp}`,
				`- threadId: ${target.threadId}`,
				params.note?.trim() ? `- note: ${params.note.trim()}` : undefined,
				emailError ? `- emailIntakeError: ${emailError}` : undefined,
				"",
				`## Phase 1`,
				"",
				phase1.archiveSummaryMarkdown.trim(),
				"",
				phase1.consolidatedFindingsMarkdown.trim(),
				"",
				`## Phase 2`,
				"",
				phase2.archiveSummaryMarkdown.trim(),
				"",
				phase2.memoryLinkingMarkdown.trim(),
				"",
				`## Phase 3`,
				"",
				phase3.archiveSummaryMarkdown.trim(),
				"",
				`## Digest`,
				"",
				digestBody.trim(),
				reviewBody.trim() ? `\n## Review\n\n${reviewBody.trim()}` : undefined,
			].filter(Boolean).join("\n"));

			const processedInbox = phase1.processedInboxPaths ?? [];
			const archivedInbox = await moveInboxItemsToArchive(rootDir, processedInbox, timestampStamp);

			if (resetThread) await queueTelegramReset(hostUrl, target.threadId);

			const summaryLines = [
				"Dream complete.",
				"",
				phase3.digestMarkdown.trim(),
				"",
				createdEvents.length > 0 ? "Calendar events created:" : undefined,
				...createdEvents.map(({ event, targetCalendar }) => `- ${event.summary} (${targetCalendar.name})`),
				calendarErrors.length > 0 ? "Calendar creation errors:" : undefined,
				...calendarErrors.map((line) => `- ${line}`),
				"",
				"Artifacts:",
				`- digest: ${digestFile.relativePath}`,
				reviewFile ? `- review: ${reviewFile.relativePath}` : undefined,
				`- telegram archive: ${telegramArchive.relativePath}`,
				`- dream archive: ${dreamArchive.relativePath}`,
				`- phase 1 artifact: archive/dreams/${timestampStamp}/phase1.json`,
				`- phase 2 artifact: archive/dreams/${timestampStamp}/phase2.json`,
				`- phase 3 artifact: archive/dreams/${timestampStamp}/phase3.json`,
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
					phase1,
					phase2,
					phase3,
					graphWrites,
					archivedInbox,
					createdEvents,
					calendarErrors,
					recentEmails,
					emailError,
				},
			};
		},
	});
}
