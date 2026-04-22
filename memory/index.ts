import { readFile } from "node:fs/promises";
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
	resolveMemoryPath,
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

interface DreamCalendarEventCandidate {
	summary: string;
	start: string;
	end?: string;
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
	graphPaths: string[];
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
			end: typeof item.end === "string" ? item.end.trim() : undefined,
			location: typeof item.location === "string" ? item.location.trim() : undefined,
			description: typeof item.description === "string" ? item.description.trim() : undefined,
			allDay: typeof item.allDay === "boolean" ? item.allDay : undefined,
			calendarId: typeof item.calendarId === "string" ? item.calendarId.trim() : undefined,
			rationale: typeof item.rationale === "string" ? item.rationale.trim() : undefined,
		}))
		.filter((item) => item.summary && item.start);
}

function summarizeMarkdown(text: string, maxLines = 8): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, maxLines)
		.join("\n");
}

function validatePhase1Plan(parsed: DreamPhase1Plan): DreamPhase1Plan {
	if (!parsed.consolidatedFindingsMarkdown?.trim() && parsed.archiveSummaryMarkdown?.trim()) {
		parsed.consolidatedFindingsMarkdown = parsed.archiveSummaryMarkdown.trim();
	}
	if (!parsed.archiveSummaryMarkdown?.trim() && parsed.consolidatedFindingsMarkdown?.trim()) {
		parsed.archiveSummaryMarkdown = summarizeMarkdown(parsed.consolidatedFindingsMarkdown);
	}
	if (!parsed.consolidatedFindingsMarkdown?.trim()) throw new Error("Dream phase 1 output missing consolidatedFindingsMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) throw new Error("Dream phase 1 output missing archiveSummaryMarkdown.");
	parsed.candidateGraphQueries = Array.isArray(parsed.candidateGraphQueries)
		? parsed.candidateGraphQueries.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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
	if (!parsed.memoryLinkingMarkdown?.trim()) throw new Error("Dream phase 2 output missing memoryLinkingMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) parsed.archiveSummaryMarkdown = summarizeMarkdown(parsed.memoryLinkingMarkdown);
	parsed.graphPaths = Array.isArray(parsed.graphPaths)
		? parsed.graphPaths.filter((value): value is string => typeof value === "string" && value.startsWith("graph/"))
		: [];
	parsed.candidateCalendarEvents = normalizeCalendarEventCandidates(parsed.candidateCalendarEvents);
	return parsed;
}

function validatePhase3Plan(parsed: DreamPhase3Plan): DreamPhase3Plan {
	if (!parsed.digestMarkdown?.trim()) throw new Error("Dream phase 3 output missing digestMarkdown.");
	if (!parsed.archiveSummaryMarkdown?.trim()) parsed.archiveSummaryMarkdown = summarizeMarkdown(parsed.digestMarkdown);
	parsed.calendarEvents = normalizeCalendarEventCandidates(parsed.calendarEvents);
	return parsed;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(text: string, titles: string[]): string | undefined {
	const pattern = titles.map(escapeRegExp).join("|");
	const match = text.match(new RegExp(`(?:^|\\n)#{1,6}\\s*(?:${pattern})\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|$)`, "i"));
	const section = match?.[1]?.trim();
	return section || undefined;
}

function parseBulletListSection(text: string | undefined): string[] {
	if (!text?.trim()) return [];
	if (/^none\b/i.test(text.trim())) return [];
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim() ?? line.match(/^\d+[.)]\s+(.+)$/)?.[1]?.trim() ?? "")
		.filter(Boolean);
}

function parseBooleanLike(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "y", "1"].includes(normalized)) return true;
	if (["false", "no", "n", "0"].includes(normalized)) return false;
	return undefined;
}

function parseCalendarEventSection(text: string | undefined): DreamCalendarEventCandidate[] {
	if (!text?.trim()) return [];
	if (/^none\b/i.test(text.trim())) return [];
	const events: DreamCalendarEventCandidate[] = [];
	let current: Record<string, unknown> | null = null;
	const pushCurrent = () => {
		if (!current) return;
		events.push(current as unknown as DreamCalendarEventCandidate);
		current = null;
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const summaryMatch = line.match(/^[-*]\s+summary\s*:\s*(.+)$/i) ?? line.match(/^summary\s*:\s*(.+)$/i);
		if (summaryMatch) {
			pushCurrent();
			current = { summary: summaryMatch[1].trim() };
			continue;
		}
		const fieldMatch = line.match(/^(?:[-*]\s+)?([A-Za-z][A-Za-z ]*?)\s*:\s*(.+)$/);
		if (!fieldMatch || !current) continue;
		const key = fieldMatch[1].trim().toLowerCase();
		const value = fieldMatch[2].trim();
		if (key === "start") current.start = value;
		else if (key === "end") current.end = value;
		else if (key === "location") current.location = value;
		else if (key === "description") current.description = value;
		else if (key === "all day" || key === "allday") current.allDay = parseBooleanLike(value);
		else if (key === "calendar" || key === "calendar id" || key === "calendarid") current.calendarId = value;
		else if (key === "rationale") current.rationale = value;
	}
	pushCurrent();
	return normalizeCalendarEventCandidates(events);
}

function parseArtifactAsJson<T>(text: string, validator: (parsed: T) => T): T {
	return validator(JSON.parse(extractJsonObject(text)) as T);
}

function parsePhase1Artifact(text: string): DreamPhase1Plan {
	try {
		return parseArtifactAsJson<DreamPhase1Plan>(text, validatePhase1Plan);
	} catch {
		const findings = extractMarkdownSection(text, ["Consolidated Findings", "Findings", "Notes"]) || text.trim();
		return validatePhase1Plan({
			archiveSummaryMarkdown: extractMarkdownSection(text, ["Archive Summary", "Summary"]) || summarizeMarkdown(findings),
			consolidatedFindingsMarkdown: findings,
			candidateGraphQueries: parseBulletListSection(extractMarkdownSection(text, ["Candidate Graph Queries", "Graph Queries", "Graph Search Queries"])),
			processedInboxPaths: parseBulletListSection(extractMarkdownSection(text, ["Processed Inbox", "Inbox To Archive", "Processed Inbox Paths"])),
			retainedInboxPaths: parseBulletListSection(extractMarkdownSection(text, ["Retained Inbox", "Inbox To Keep", "Retained Inbox Paths"])),
			candidateCalendarEvents: parseCalendarEventSection(extractMarkdownSection(text, ["Candidate Calendar Events", "Calendar Candidates"])),
		});
	}
}

function parsePhase2Artifact(text: string): DreamPhase2Plan {
	try {
		return parseArtifactAsJson<DreamPhase2Plan>(text, validatePhase2Plan);
	} catch {
		const memoryLinking = extractMarkdownSection(text, ["Memory Linking", "Graph Linking", "Linking", "Findings"]) || text.trim();
		return validatePhase2Plan({
			archiveSummaryMarkdown: extractMarkdownSection(text, ["Archive Summary", "Summary"]) || summarizeMarkdown(memoryLinking),
			memoryLinkingMarkdown: memoryLinking,
			graphPaths: parseBulletListSection(extractMarkdownSection(text, ["Graph Files Updated", "Graph Files Changed", "Graph Paths"])),
			candidateCalendarEvents: parseCalendarEventSection(extractMarkdownSection(text, ["Candidate Calendar Events", "Calendar Candidates"])),
		});
	}
}

function parsePhase3Artifact(text: string): DreamPhase3Plan {
	try {
		return parseArtifactAsJson<DreamPhase3Plan>(text, validatePhase3Plan);
	} catch {
		const digest = extractMarkdownSection(text, ["Digest", "Daily Digest", "User Digest"]) || text.trim();
		const reviewSection = extractMarkdownSection(text, ["Review", "Review Note", "Follow-up"]);
		return validatePhase3Plan({
			archiveSummaryMarkdown: extractMarkdownSection(text, ["Archive Summary", "Summary"]) || summarizeMarkdown(digest),
			digestMarkdown: digest,
			reviewMarkdown: reviewSection && !/^none\b/i.test(reviewSection) ? reviewSection : undefined,
			calendarEvents: parseCalendarEventSection(extractMarkdownSection(text, ["Calendar Events To Create", "Calendar Events", "Events To Create"])),
		});
	}
}

function isDateOnlyValue(value: string | undefined): boolean {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function parseFlexibleDateTime(value: string | undefined): Date | undefined {
	if (!value?.trim()) return undefined;
	const trimmed = value.trim();
	const direct = new Date(trimmed);
	if (!Number.isNaN(direct.getTime())) return direct;
	const localDateTime = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (localDateTime) {
		const [, date, hour, minute, second] = localDateTime;
		const parsed = new Date(`${date}T${hour}:${minute}:${second ?? "00"}`);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	const dutchStyle = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
	if (dutchStyle) {
		const [, day, month, year, hour = "00", minute = "00", second = "00"] = dutchStyle;
		const parsed = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour}:${minute}:${second}`);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return undefined;
}

function normalizeCalendarCandidateForCreation(
	candidate: DreamCalendarEventCandidate,
): { event: DreamCalendarEventCandidate & { start: string; end: string; allDay: boolean } } | { error: string } {
	const startRaw = candidate.start?.trim();
	const endRaw = candidate.end?.trim();
	if (!startRaw) return { error: "missing start timestamp" };
	const dateOnly = candidate.allDay === true || isDateOnlyValue(startRaw) || isDateOnlyValue(endRaw);
	if (dateOnly) {
		const day = startRaw.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1] ?? endRaw?.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
		if (!day) return { error: `could not normalize all-day date from start=${JSON.stringify(startRaw)} end=${JSON.stringify(endRaw)}` };
		const start = `${day}T00:00:00.000`;
		const startDate = new Date(start);
		const endDate = new Date(startDate);
		if (endRaw && /^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
			const parsedEnd = new Date(`${endRaw}T00:00:00.000`);
			if (!Number.isNaN(parsedEnd.getTime()) && parsedEnd > startDate) {
				return { event: { ...candidate, start: startDate.toISOString(), end: parsedEnd.toISOString(), allDay: true } };
			}
		}
		endDate.setDate(endDate.getDate() + 1);
		return { event: { ...candidate, start: startDate.toISOString(), end: endDate.toISOString(), allDay: true } };
	}
	const startDate = parseFlexibleDateTime(startRaw);
	if (!startDate) return { error: `invalid start timestamp: ${JSON.stringify(startRaw)}` };
	const endDate = endRaw ? parseFlexibleDateTime(endRaw) : undefined;
	if (endRaw && !endDate) return { error: `invalid end timestamp: ${JSON.stringify(endRaw)}` };
	const normalizedEnd = endDate ?? new Date(startDate.getTime() + 60 * 60 * 1000);
	if (normalizedEnd <= startDate) {
		return { event: { ...candidate, start: startDate.toISOString(), end: new Date(startDate.getTime() + 60 * 60 * 1000).toISOString(), allDay: false } };
	}
	return { event: { ...candidate, start: startDate.toISOString(), end: normalizedEnd.toISOString(), allDay: false } };
}

async function runDreamPhase(
	ctx: any,
	config: any,
	subagentCore: SubagentCoreAPI,
	phaseLabel: string,
	task: string,
	artifactAbsolutePath: string,
): Promise<string> {
	const result = await subagentCore.runSubagent(ctx, config, {
		role: "memory",
		label: phaseLabel,
		task,
		tools: "full",
		timeout: 1800000,
	});
	if (result.exitCode !== 0) throw new Error(result.errorMessage || `${phaseLabel} failed.`);
	try {
		const artifactText = await readFile(artifactAbsolutePath, "utf8");
		if (!artifactText.trim()) throw new Error(`${phaseLabel} artifact is empty.`);
		return artifactText;
	} catch (error) {
		const output = result.output.trim();
		throw new Error([
			`${phaseLabel} did not write the required artifact at ${artifactAbsolutePath}.`,
			error instanceof Error ? `Artifact read error: ${error.message}` : String(error),
			output ? `Subagent output:\n${output}` : "Subagent output was empty.",
		].join("\n\n"));
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
			const telegramArchive = await writeTelegramArchive(rootDir, timestampStamp, [
				`# Telegram Transcript Archive`,
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- threadId: ${target.threadId}`,
				`- source: ${target.source}`,
				"",
				transcript || "(empty transcript)",
			].join("\n"));
			const phase1ArtifactPath = `archive/dreams/${timestampStamp}/phase1.md`;
			const phase2ArtifactPath = `archive/dreams/${timestampStamp}/phase2.md`;
			const phase3ArtifactPath = `archive/dreams/${timestampStamp}/phase3.md`;
			const phase1ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase1ArtifactPath);
			const phase2ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase2ArtifactPath);
			const phase3ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase3ArtifactPath);
			let recentEmails: PaEmailSummary[] = [];
			let emailError: string | undefined;
			try {
				recentEmails = await searchEmailSummariesForContext(ctx, { sinceDays: 2, limit: 50 });
			} catch (error) {
				emailError = error instanceof Error ? error.message : String(error);
			}

			let phase1ArtifactText = "";
			try {
				phase1ArtifactText = await runDreamPhase(ctx, config, subagentCore, "dream-phase-1", [
					"Run dream phase 1: intake and consolidation.",
					"You are a normal subagent with full coding tools. Actually do the work. Read files, use bash, write files, and move files when needed. Do not merely describe intended actions.",
					"Task: inspect the inbox, Telegram transcript archive, and recent email summaries. Decide what should be integrated now versus retained for later.",
					"For processed inbox items, actually move them yourself out of inbox and into the archive folder for this dream run, using bash mv if needed.",
					"Leave only genuinely unresolved or intentionally retained items in inbox.",
					"If an inbox item contains a durable personal fact, preference, relationship, pet fact, project fact, or other stable context, do not leave it sitting in inbox after processing it.",
					"Write a freeform markdown artifact summarizing what you read, what you changed, what you archived, what you retained, and any graph/search directions that matter next.",
					`Required artifact path: ${phase1ArtifactAbsolutePath}`,
					`Archive processed inbox items under: ${resolveMemoryPath(rootDir, `archive/dreams/${timestampStamp}/inbox`)}`,
					params.note?.trim() ? `Dream focus note: ${params.note.trim()}` : undefined,
					`Memory root: ${rootDir}`,
					`Inbox directory: ${resolveMemoryPath(rootDir, "inbox")}`,
					`Telegram transcript archive: ${telegramArchive.absolutePath}`,
					`Local timezone: ${timezone}`,
					`Current local day: ${dayStamp}`,
					`Target Telegram thread: ${target.threadId}`,
					`Dream target source: ${target.source}`,
					formatEmailSummaries(recentEmails),
					emailError ? `Recent email intake error: ${emailError}` : undefined,
				].filter(Boolean).join("\n\n"), phase1ArtifactAbsolutePath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 1 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, telegramArchive, phase1ArtifactPath },
					isError: true,
				};
			}

			let phase2ArtifactText = "";
			try {
				phase2ArtifactText = await runDreamPhase(ctx, config, subagentCore, "dream-phase-2", [
					"Run dream phase 2: graph linking and memory integration.",
					"You are a normal subagent with full coding tools. Actually do the work. Read files, grep, use bash, edit files, and write files when needed. Do not merely describe intended actions.",
					"Task: read the phase 1 artifact, inspect graph/archive files as needed, and directly update graph files with durable memory extracted from the dream inputs.",
					"Use the graph for stable durable context: people, pets, preferences, relationships, projects, places, routines, and other reusable long-lived facts.",
					"Write a freeform markdown artifact summarizing what graph files you changed, what durable links you added, and any remaining ambiguity.",
					`Required artifact path: ${phase2ArtifactAbsolutePath}`,
					params.note?.trim() ? `Dream focus note: ${params.note.trim()}` : undefined,
					`Memory root: ${rootDir}`,
					`Phase 1 artifact: ${phase1ArtifactAbsolutePath}`,
					`Graph directory: ${resolveMemoryPath(rootDir, "graph")}`,
					`Archive directory: ${resolveMemoryPath(rootDir, "archive")}`,
				].filter(Boolean).join("\n\n"), phase2ArtifactAbsolutePath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 2 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, telegramArchive, phase1ArtifactPath, phase1ArtifactText },
					isError: true,
				};
			}

			let phase3ArtifactText = "";
			const digestRelativePath = `digest/daily/${dayStamp}.md`;
			const digestAbsolutePath = resolveMemoryPath(rootDir, digestRelativePath);
			const reviewRelativePath = `review/${dayStamp}.md`;
			const reviewAbsolutePath = resolveMemoryPath(rootDir, reviewRelativePath);
			try {
				phase3ArtifactText = await runDreamPhase(ctx, config, subagentCore, "dream-phase-3", [
					"Run dream phase 3: digest, review, and concrete event execution planning.",
					"You are a normal subagent with full coding tools. Actually do the work. Read files, write files, and use bash when needed. Do not merely describe intended actions.",
					"Task: read the phase 1 and phase 2 artifacts, then write the actual user-facing daily digest file for today.",
					"If a review note is needed, write the actual review file too. If no review note is needed, do not create one just for ceremony.",
					"If concrete calendar events should be created now, include them in the phase artifact under a readable markdown section named 'Calendar Events To Create'.",
					"Write a freeform markdown phase artifact summarizing what you wrote and any calendar events that should be created next by the outer dream tool.",
					`Required digest file path: ${digestAbsolutePath}`,
					`Optional review file path: ${reviewAbsolutePath}`,
					`Required artifact path: ${phase3ArtifactAbsolutePath}`,
					params.note?.trim() ? `Dream focus note: ${params.note.trim()}` : undefined,
					`Memory root: ${rootDir}`,
					`Phase 1 artifact: ${phase1ArtifactAbsolutePath}`,
					`Phase 2 artifact: ${phase2ArtifactAbsolutePath}`,
				].filter(Boolean).join("\n\n"), phase3ArtifactAbsolutePath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 3 failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, telegramArchive, phase1ArtifactPath, phase2ArtifactPath, phase1ArtifactText, phase2ArtifactText },
					isError: true,
				};
			}

			const graphWrites = Array.from(new Set((phase2ArtifactText.match(/\bgraph\/[A-Za-z0-9._\-/]+/g) ?? [])))
				.map((path) => ({ path, absolutePath: resolveMemoryPath(rootDir, path), relativePath: path }));

			const phase3CalendarEvents = parseCalendarEventSection(extractMarkdownSection(phase3ArtifactText, ["Calendar Events To Create", "Calendar Events", "Events To Create"]));
			const createdEvents: Array<{ event: PaCalendarEvent; targetCalendar: { id: string; name: string }; rationale?: string }> = [];
			const normalizedCalendarEvents: Array<DreamCalendarEventCandidate & { start: string; end: string; allDay: boolean }> = [];
			const calendarErrors: string[] = [];
			for (const candidate of phase3CalendarEvents) {
				const normalized = normalizeCalendarCandidateForCreation(candidate);
				if ("error" in normalized) {
					calendarErrors.push(`${candidate.summary}: ${normalized.error}`);
					continue;
				}
				normalizedCalendarEvents.push(normalized.event);
				try {
					const created = await createCalendarEventForContext(ctx, normalized.event);
					createdEvents.push({ ...created, rationale: candidate.rationale });
				} catch (error) {
					calendarErrors.push(`${candidate.summary}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			let digestText: string;
			try {
				digestText = (await readFile(digestAbsolutePath, "utf8")).trim();
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream phase 3 failed: digest file was not written (${error instanceof Error ? error.message : String(error)})` }],
					details: { threadId: target.threadId, telegramArchive, phase1ArtifactPath, phase2ArtifactPath, phase3ArtifactPath, phase1ArtifactText, phase2ArtifactText, phase3ArtifactText },
					isError: true,
				};
			}

			let reviewText = "";
			try {
				reviewText = (await readFile(reviewAbsolutePath, "utf8")).trim();
			} catch {
				reviewText = "";
			}

			const digestBody = [
				digestText,
				createdEvents.length > 0
					? ["", "## Calendar events created", "", ...createdEvents.map(({ event, targetCalendar, rationale }) => `- ${event.summary} | ${event.start} → ${event.end} | ${targetCalendar.name}${rationale ? ` | ${rationale}` : ""}`)].join("\n")
					: undefined,
				calendarErrors.length > 0
					? ["", "## Calendar event creation errors", "", ...calendarErrors.map((line) => `- ${line}`)].join("\n")
					: undefined,
			].filter(Boolean).join("\n");
			const reviewBody = [
				reviewText || undefined,
				calendarErrors.length > 0
					? ["## Calendar follow-up", "", ...calendarErrors.map((line) => `- ${line}`)].join("\n")
					: undefined,
			].filter(Boolean).join("\n\n");

			const digestFile = await writeDailyDigest(rootDir, dayStamp, digestBody);
			const reviewFile = reviewBody.trim() ? await writeReviewFile(rootDir, dayStamp, reviewBody.trim()) : undefined;
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
				`## Phase 1 Artifact`,
				"",
				phase1ArtifactText.trim(),
				"",
				`## Phase 2 Artifact`,
				"",
				phase2ArtifactText.trim(),
				"",
				`## Phase 3 Artifact`,
				"",
				phase3ArtifactText.trim(),
				"",
				`## Digest`,
				"",
				digestBody.trim(),
				reviewBody.trim() ? `\n## Review\n\n${reviewBody.trim()}` : undefined,
			].filter(Boolean).join("\n"));

			const archivedInboxFiles = await listMemoryFiles(rootDir, `archive/dreams/${timestampStamp}/inbox`, { recursive: true });
			const archivedInbox = archivedInboxFiles.map((file) => ({ from: "inbox/unknown", to: file.relativePath }));

			if (resetThread) await queueTelegramReset(hostUrl, target.threadId);

			const summaryLines = [
				"Dream complete.",
				"",
				digestText,
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
				`- phase 1 artifact: ${phase1ArtifactPath}`,
				`- phase 2 artifact: ${phase2ArtifactPath}`,
				`- phase 3 artifact: ${phase3ArtifactPath}`,
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
					phase1ArtifactText,
					phase2ArtifactText,
					phase3ArtifactText,
					graphWrites,
					archivedInbox,
					createdEvents,
					normalizedCalendarEvents,
					calendarErrors,
					recentEmails,
					emailError,
				},
			};
		},
	});
}
