import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";
import { ensureAutodreamScheduled } from "../schedule/index.js";
import { parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import type { HostedSessionHandle, HostedSessionSnapshot, HostedSessionSummary, SessionHost } from "../runtime/session-host-types.js";
import type { PaEmailSummary } from "../pa/shared/types.js";
import { searchEmailSummariesForContext } from "../pa/mail/index.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import {
	createInboxMemoryItem,
	ensureMemoryDirs,
	getLocalDateParts,
	getMemoryRootDir,
	inspectMemoryPath,
	resolveMemoryPath,
	writeMemoryFile,
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

function formatSessionSummaries(sessions: HostedSessionSummary[]): string {
	if (sessions.length === 0) return "Other open sessions: none";
	return [
		"Other open sessions",
		...sessions.map((session) => [
			`- sessionId=${session.sessionId}`,
			session.kind,
			session.runState,
			session.updatedAt,
			session.title ? `title=${session.title}` : undefined,
			session.cwd ? `cwd=${session.cwd}` : undefined,
			session.assistantChannel ? `channel=${session.assistantChannel}` : undefined,
			session.assistantThreadId ? `thread=${session.assistantThreadId}` : undefined,
		].filter(Boolean).join(" | ")),
	].join("\n");
}

function extractMarkdownField(text: string, field: string): string | undefined {
	const match = text.match(new RegExp(`^[-*]\\s+${field}\\s*:\\s*(.+)$`, "im"));
	return match?.[1]?.trim();
}

function isTruthyMarkdownField(text: string, field: string): boolean {
	const value = extractMarkdownField(text, field)?.toLowerCase();
	return value === "true" || value === "yes" || value === "1";
}

function describeHostFetchError(url: URL, error: unknown) {
	const reason = error instanceof Error ? error.message : String(error);
	return `Could not reach Magpie assistant host at ${url.toString()}: ${reason}. Ensure the webui/assistant host is running and telegram.hostUrl points to it from this machine.`;
}

async function parseJsonResponse(response: Response) {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

async function getJson<T>(baseUrl: string, path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new Error(describeHostFetchError(url, error));
	}
	const json = await parseJsonResponse(response);
	if (!response.ok) throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status} for ${url.toString()}`);
	return json as T;
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
	const url = new URL(path, baseUrl);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Error(describeHostFetchError(url, error));
	}
	const json = await parseJsonResponse(response);
	if (!response.ok) throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status} for ${url.toString()}`);
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

async function listOtherOpenSessions(hostUrl: string, currentSessionId: string | undefined, targetThreadId: string, include: boolean) {
	if (!include) return [] as HostedSessionSummary[];
	const listed = await getJson<{ sessions: HostedSessionSummary[] }>(hostUrl, "/api/v1/sessions", {
		includeArchived: 0,
		limit: 25,
	});
	return listed.sessions.filter((session) => {
		if (session.sessionId === currentSessionId) return false;
		if (session.assistantChannel === "telegram" && session.assistantThreadId === targetThreadId) return false;
		return session.location !== "archived";
	});
}

function getDirectAssistantHost(pi: ExtensionAPI): SessionHost | undefined {
	let runtime: { host?: SessionHost } | undefined;
	pi.events.emit("magpie:webui:get-runtime", (value: unknown) => {
		runtime = value as { host?: SessionHost } | undefined;
	});
	return runtime?.host;
}

function modelRefFromContext(ctx: any): string | undefined {
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

async function createDreamOrchestratorSession(host: SessionHost, modelRef: string): Promise<HostedSessionHandle> {
	return await host.createSession({
		kind: "assistant",
		origin: "assistant",
		title: "Dream orchestrator",
		assistantChannel: "internal",
		assistantThreadId: `dream-${randomUUID()}`,
		workspaceMode: "none",
		modelRef,
		toolNames: [
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"read_memory",
			"write_memory",
			"memory_subagent",
			"calendar_create_event",
		],
	});
}

async function promptDreamOrchestrator(session: HostedSessionHandle, modelRef: string, text: string): Promise<{ text: string }> {
	await session.sendUserMessage({ text, modelRef, source: "system" });
	const snapshot = await session.getSnapshot(modelRef, 12);
	const lastAssistant = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === "assistant");
	return { text: lastAssistant?.text?.trim() || "" };
}

function buildDreamContextMarkdown(input: {
	now: Date;
	timezone: string;
	dayStamp: string;
	timestampStamp: string;
	note?: string;
	threadId: string;
	targetSource: string;
	resetThread: boolean;
	telegramArchiveAbsolutePath: string;
	telegramArchiveRelativePath: string;
	phase1ArtifactRelativePath: string;
	phase2ArtifactRelativePath: string;
	phase3ArtifactRelativePath: string;
	summaryRelativePath: string;
	digestRelativePath: string;
	reviewRelativePath: string;
	planDocPath: string;
	recentEmails: PaEmailSummary[];
	emailError?: string;
	otherSessions: HostedSessionSummary[];
	rootDir: string;
}) {
	return [
		"# Dream Run Context",
		"",
		`- dreamedAt: ${input.now.toISOString()}`,
		`- timezone: ${input.timezone}`,
		`- dayStamp: ${input.dayStamp}`,
		`- timestampStamp: ${input.timestampStamp}`,
		`- threadId: ${input.threadId}`,
		`- targetSource: ${input.targetSource}`,
		`- resetThreadRequested: ${input.resetThread ? "true" : "false"}`,
		input.note?.trim() ? `- note: ${input.note.trim()}` : undefined,
		"",
		"## Memory Paths",
		"",
		`- memoryRoot: ${input.rootDir}`,
		`- telegramArchive: ${input.telegramArchiveRelativePath}`,
		`- telegramArchiveAbsolutePath: ${input.telegramArchiveAbsolutePath}`,
		`- phase1Artifact: ${input.phase1ArtifactRelativePath}`,
		`- phase2Artifact: ${input.phase2ArtifactRelativePath}`,
		`- phase3Artifact: ${input.phase3ArtifactRelativePath}`,
		`- digest: ${input.digestRelativePath}`,
		`- review: ${input.reviewRelativePath}`,
		`- summary: ${input.summaryRelativePath}`,
		"",
		"## Design Reference",
		"",
		`- planDocPath: ${input.planDocPath}`,
		"- The phase responsibilities must follow the original plan doc.",
		"",
		"## Phase Responsibilities",
		"",
		"### Phase 1",
		"- intake, transcript compaction, and handoff preparation",
		"- inspect inbox, archived Telegram transcript, and recent email summaries",
		"- write phase1 markdown artifact",
		"- do not curate graph in phase 1",
		"",
		"### Phase 2",
		"- inbox to graph integration",
		"- read phase1 artifact first",
		"- process inbox items into graph files",
		"- archive processed inbox items under this dream run",
		"- write phase2 markdown artifact",
		"",
		"### Phase 3",
		"- write daily digest",
		"- optionally write review file",
		"- include calendar events in markdown if they should be created now",
		"- write phase3 markdown artifact",
		"",
		formatEmailSummaries(input.recentEmails),
		input.emailError ? `Recent email intake error: ${input.emailError}` : undefined,
		"",
		formatSessionSummaries(input.otherSessions),
	].filter(Boolean).join("\n");
}

function buildDreamOrchestratorPrompt(input: {
	contextRelativePath: string;
	contextAbsolutePath: string;
	planDocPath: string;
	phase1ArtifactAbsolutePath: string;
	phase2ArtifactAbsolutePath: string;
	phase3ArtifactAbsolutePath: string;
	digestAbsolutePath: string;
	reviewAbsolutePath: string;
	summaryRelativePath: string;
	rootDir: string;
}) {
	return [
		"Run the dream orchestration now.",
		"You are the orchestrator for a dream run. You are not one of the phase subagents.",
		"Read the context file first, then read the plan doc before dispatching any phase.",
		"Use the memory_subagent tool to run exactly three sequential memory phase subagents.",
		"Each phase subagent gets one focused task and must write its own markdown artifact file.",
		"When you dispatch a phase, explicitly tell the phase subagent to use real tools, not narration.",
		"Tell each phase subagent to use the write tool to create the required artifact path directly. The write tool can create parent directories.",
		"Tell phase 2 to move processed inbox items itself using shell/file tools.",
		"Handoff is file-based. Verify the required artifact exists and is non-empty before moving on.",
		"If a phase fails, retry that phase up to 3 total attempts with a short corrective task. Fail loudly if the third attempt still fails.",
		"Do not use search_subagent, oracle_subagent, or librarian_subagent. They are not available here.",
		"Do not require JSON or structured outputs from the phase agents. All artifacts must be freeform markdown.",
		"For phase 3, if the artifact includes concrete calendar events to create now, create them yourself with calendar_create_event, then update the digest file so it mentions what was created or what failed.",
		"If calendar creation fails for any event, preserve that failure in the digest and review note when appropriate.",
		"At the end, write a final markdown summary to the required summary path.",
		"The final summary must contain markdown bullet lines for at least:",
		"- status: success|failure",
		"- failedPhase: none|phase1|phase2|phase3|calendar|finalize",
		"- shouldResetTelegramThread: true|false",
		"- phase1Artifact: <relative path>",
		"- phase2Artifact: <relative path>",
		"- phase3Artifact: <relative path>",
		"- digest: <relative path>",
		"- review: <relative path or none>",
		"- summary: <relative path>",
		"You may add any other headings and notes you want.",
		"",
		`Required context file: ${input.contextAbsolutePath}`,
		`Context file relative path: ${input.contextRelativePath}`,
		`Plan doc: ${input.planDocPath}`,
		`Memory root: ${input.rootDir}`,
		`Phase 1 artifact absolute path: ${input.phase1ArtifactAbsolutePath}`,
		`Phase 2 artifact absolute path: ${input.phase2ArtifactAbsolutePath}`,
		`Phase 3 artifact absolute path: ${input.phase3ArtifactAbsolutePath}`,
		`Digest absolute path: ${input.digestAbsolutePath}`,
		`Optional review absolute path: ${input.reviewAbsolutePath}`,
		`Required summary relative path: ${input.summaryRelativePath}`,
		"",
		"Use phase tasks shaped like this:",
		"",
		"Phase 1 task template:",
		`Run dream phase 1: intake, transcript compaction, and handoff preparation. Actually do the work using tools. Read the context file and transcript archive, inspect inbox and recent email notes, do not curate graph in phase 1, and write a freeform markdown artifact to ${input.phase1ArtifactAbsolutePath}. Use the write tool to create that exact file path.`,
		"",
		"Phase 2 task template:",
		`Run dream phase 2: inbox-to-graph integration. Actually do the work using tools. Read phase 1 artifact first, inspect graph/archive as needed, process inbox items into long-term graph files, archive processed inbox items under this dream run, and write a freeform markdown artifact to ${input.phase2ArtifactAbsolutePath}. Use the write tool to create that exact file path.`,
		"",
		"Phase 3 task template:",
		`Run dream phase 3: digest, review, and calendar planning. Actually do the work using tools. Read phase 1 and phase 2 artifacts first, write the actual digest file to ${input.digestAbsolutePath}, optionally write review file to ${input.reviewAbsolutePath}, and write a freeform markdown artifact to ${input.phase3ArtifactAbsolutePath}. Use the write tool to create the artifact path. If events should be created now, include them under a markdown heading named Calendar Events To Create.`,
	].join("\n\n");
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
		name: "memory_subagent",
		label: "Memory Subagent",
		description: "Internal-only tool for the dream orchestrator to run a focused memory phase subagent.",
		promptSnippet: "Internal-only memory phase dispatch tool.",
		parameters: Type.Object({
			label: Type.Optional(Type.String({ description: "Optional label for the subagent run" })),
			task: Type.String({ description: "Focused task for the memory subagent" }),
			timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Optional phase timeout in minutes (default 30)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Memory subagent unavailable." }], details: {}, isError: true };
			}
			const config = await loadConfig(ctx.cwd);
			const result = await subagentCore.runSubagent(ctx, config, {
				role: "memory",
				label: params.label?.trim() || "memory-phase",
				task: params.task,
				tools: "full",
				timeout: Math.min(Math.max(params.timeoutMinutes ?? 30, 1), 30) * 60_000,
			}, signal);
			if (result.exitCode !== 0) {
				return {
					content: [{ type: "text", text: result.errorMessage || result.output || "Memory subagent failed." }],
					details: { result },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: result.output.trim() || "(no output)" }],
				details: { result },
			};
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!subagentCore) {
				return { content: [{ type: "text", text: "Memory subagent unavailable." }], details: {}, isError: true };
			}
			const config = await loadConfig(ctx.cwd);
			const rootDir = getMemoryRootDir(config.memory);
			const result = await subagentCore.runSubagent(ctx, config, {
				role: "memory",
				label: "recall-memory",
				context: [
					"You are answering a memory recall query against the memory filesystem.",
					`The memory root directory is: ${rootDir}`,
					"Search the memory root yourself using the available file tools. Do not assume relevant files have already been selected for you.",
					"Use the memory root as your search boundary unless the task explicitly requires something else.",
				].join("\n"),
				task: [
					"Answer the memory query by searching the memory files yourself.",
					"Prefer targeted search over reading large amounts of irrelevant material.",
					"Return a concise synthesized answer followed by a References section that names the relevant file paths under the memory root.",
					`Memory query: ${params.query.trim()}`,
					params.limit
						? `You may inspect more files if needed, but try to keep the final set of directly relevant referenced files to about ${Math.min(params.limit, 20)} or fewer.`
						: undefined,
				].filter(Boolean).join("\n\n"),
				tools: "full",
				timeout: 180000,
			}, signal);
			if (result.exitCode !== 0) {
				return { content: [{ type: "text", text: result.errorMessage || "Memory recall failed." }], details: { result }, isError: true };
			}
			return {
				content: [{ type: "text", text: result.output.trim() }],
				details: { result },
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
			const config = await loadConfig(ctx.cwd);
			const rootDir = getMemoryRootDir(config.memory);
			await ensureMemoryDirs(rootDir);
			const hostUrl = config.telegram?.hostUrl?.trim() || "http://127.0.0.1:8787";
			const directHost = getDirectAssistantHost(pi);
			const modelRef = modelRefFromContext(ctx);
			if (!modelRef) {
				return { content: [{ type: "text", text: "Could not determine a modelRef for the dream orchestrator." }], details: {}, isError: true };
			}
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
				"# Telegram Transcript Archive",
				"",
				`- dreamedAt: ${now.toISOString()}`,
				`- threadId: ${target.threadId}`,
				`- source: ${target.source}`,
				"",
				transcript || "(empty transcript)",
			].join("\n"));

			let recentEmails: PaEmailSummary[] = [];
			let emailError: string | undefined;
			try {
				recentEmails = await searchEmailSummariesForContext(ctx, { sinceDays: 2, limit: 50 });
			} catch (error) {
				emailError = error instanceof Error ? error.message : String(error);
			}

			let otherSessions: HostedSessionSummary[] = [];
			try {
				otherSessions = await listOtherOpenSessions(hostUrl, currentSessionId, target.threadId, params.includeOpenSessions !== false);
			} catch (error) {
				emailError = emailError ?? `Open session summary unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}

			const phase1ArtifactPath = `archive/dreams/${timestampStamp}/phase1.md`;
			const phase2ArtifactPath = `archive/dreams/${timestampStamp}/phase2.md`;
			const phase3ArtifactPath = `archive/dreams/${timestampStamp}/phase3.md`;
			const summaryPath = `archive/dreams/${timestampStamp}/orchestrator.md`;
			const contextPath = `archive/dreams/${timestampStamp}/context.md`;
			const digestPath = `digest/daily/${dayStamp}.md`;
			const reviewPath = `review/${dayStamp}.md`;

			const phase1ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase1ArtifactPath);
			const phase2ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase2ArtifactPath);
			const phase3ArtifactAbsolutePath = resolveMemoryPath(rootDir, phase3ArtifactPath);
			const summaryAbsolutePath = resolveMemoryPath(rootDir, summaryPath);
			const contextAbsolutePath = resolveMemoryPath(rootDir, contextPath);
			const digestAbsolutePath = resolveMemoryPath(rootDir, digestPath);
			const reviewAbsolutePath = resolveMemoryPath(rootDir, reviewPath);
			const planDocPath = resolveMemoryPath(ctx.cwd, ".pi/context/memory/magpie-memory-system-v2.doc.md");

			await writeMemoryFile(rootDir, contextPath, buildDreamContextMarkdown({
				now,
				timezone,
				dayStamp,
				timestampStamp,
				note: params.note,
				threadId: target.threadId,
				targetSource: target.source,
				resetThread,
				telegramArchiveAbsolutePath: telegramArchive.absolutePath,
				telegramArchiveRelativePath: telegramArchive.relativePath,
				phase1ArtifactRelativePath: phase1ArtifactPath,
				phase2ArtifactRelativePath: phase2ArtifactPath,
				phase3ArtifactRelativePath: phase3ArtifactPath,
				summaryRelativePath: summaryPath,
				digestRelativePath: digestPath,
				reviewRelativePath: reviewPath,
				planDocPath,
				recentEmails,
				emailError,
				otherSessions,
				rootDir,
			}));

			let orchestratorSessionId: string;
			let orchestratorResponse: { text: string };
			try {
				const orchestratorSession = directHost
					? await createDreamOrchestratorSession(directHost, modelRef)
					: await (async () => {
						const created = await postJson<{ sessionId: string }>(hostUrl, "/api/v1/sessions", {
							kind: "assistant",
							origin: "assistant",
							title: "Dream orchestrator",
							assistantChannel: "internal",
							assistantThreadId: `dream-${randomUUID()}`,
							workspaceMode: "none",
							modelRef,
							toolNames: ["read", "bash", "grep", "find", "ls", "read_memory", "write_memory", "memory_subagent", "calendar_create_event"],
						});
						const session = await getJson<HostedSessionSnapshot>(hostUrl, `/api/v1/sessions/${encodeURIComponent(created.sessionId)}/snapshot`, { modelRef }).catch(() => undefined);
						return { metadata: { sessionId: created.sessionId }, getSnapshot: async () => session } as unknown as HostedSessionHandle;
					})();
				orchestratorSessionId = orchestratorSession.metadata.sessionId;
				orchestratorResponse = directHost
					? await promptDreamOrchestrator(orchestratorSession, modelRef, buildDreamOrchestratorPrompt({
						contextRelativePath: contextPath,
						contextAbsolutePath,
						planDocPath,
						phase1ArtifactAbsolutePath,
						phase2ArtifactAbsolutePath,
						phase3ArtifactAbsolutePath,
						digestAbsolutePath,
						reviewAbsolutePath,
						summaryRelativePath: summaryPath,
						rootDir,
					}))
					: await postJson<{ text: string }>(hostUrl, `/api/v1/sessions/${encodeURIComponent(orchestratorSession.metadata.sessionId)}/message`, {
						text: buildDreamOrchestratorPrompt({
							contextRelativePath: contextPath,
							contextAbsolutePath,
							planDocPath,
							phase1ArtifactAbsolutePath,
							phase2ArtifactAbsolutePath,
							phase3ArtifactAbsolutePath,
							digestAbsolutePath,
							reviewAbsolutePath,
							summaryRelativePath: summaryPath,
							rootDir,
						}),
						modelRef,
					});
			} catch (error) {
				return {
					content: [{ type: "text", text: `Dream orchestrator failed to run: ${error instanceof Error ? error.message : String(error)}` }],
					details: { threadId: target.threadId, contextPath, summaryPath, telegramArchive },
					isError: true,
				};
			}

			let summaryText = "";
			try {
				summaryText = (await readFile(summaryAbsolutePath, "utf8")).trim();
			} catch {
				summaryText = orchestratorResponse.text?.trim() || "";
			}

			const success = (extractMarkdownField(summaryText, "status") || "").toLowerCase() === "success";
			const shouldResetFromSummary = isTruthyMarkdownField(summaryText, "shouldResetTelegramThread");
			if (success && resetThread && shouldResetFromSummary) await queueTelegramReset(hostUrl, target.threadId);

			const summaryOutput = summaryText || orchestratorResponse.text || "Dream orchestrator completed without a readable summary.";
			return {
				content: [{ type: "text", text: summaryOutput }],
				details: {
					dayStamp,
					timestampStamp,
					threadId: target.threadId,
					targetSource: target.source,
					telegramArchive,
					contextPath,
					summaryPath,
					summaryText,
					orchestratorSessionId,
					success,
					resetQueued: success && resetThread && shouldResetFromSummary,
					recentEmails,
					emailError,
					otherSessions: otherSessions.map((session) => ({ sessionId: session.sessionId, title: session.title, kind: session.kind, runState: session.runState })),
				},
				isError: !success,
			};
		},
	});
}
