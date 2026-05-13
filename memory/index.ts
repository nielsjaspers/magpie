import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.js";
import { ensureAutodreamScheduled } from "../schedule/index.js";
import type { HostedSessionSnapshot, HostedSessionSummary } from "../runtime/session-host-types.js";
import type { PaEmailSummary } from "../pa/shared/types.js";
import { searchEmailSummariesForContext } from "../pa/mail/index.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { createDreamOrchestratorSession, createRemoteDreamOrchestratorSession, getDirectAssistantHost, modelRefFromContext, promptDreamOrchestrator, promptRemoteDreamOrchestrator } from "./dream-orchestrator.js";
import { buildDreamContextMarkdown, buildDreamOrchestratorPrompt } from "./dream-prompts.js";
import { getAssistantSnapshot, listOtherOpenSessions, queueTelegramReset, resolveDreamTarget } from "./host-client.js";
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

function extractMarkdownField(text: string, field: string): string | undefined {
	const match = text.match(new RegExp(`^[-*]\\s+${field}\\s*:\\s*(.+)$`, "im"));
	return match?.[1]?.trim();
}

function isTruthyMarkdownField(text: string, field: string): boolean {
	const value = extractMarkdownField(text, field)?.toLowerCase();
	return value === "true" || value === "yes" || value === "1";
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
					: await createRemoteDreamOrchestratorSession(hostUrl, modelRef);
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
					: await promptRemoteDreamOrchestrator(
						hostUrl,
						orchestratorSession.metadata.sessionId,
						modelRef,
						buildDreamOrchestratorPrompt({
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
					);
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
