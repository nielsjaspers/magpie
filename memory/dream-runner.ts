import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import type { HostedSessionSnapshot, HostedSessionSummary } from "../runtime/session-host-types.js";
import type { PaEmailSummary } from "../pa/shared/types.js";
import { searchEmailSummariesForContext } from "../pa/mail/index.js";
import {
	createDreamOrchestratorSession,
	createRemoteDreamOrchestratorSession,
	getDirectAssistantHost,
	modelRefFromContext,
	promptDreamOrchestrator,
	promptRemoteDreamOrchestrator,
} from "./dream-orchestrator.js";
import { buildDreamContextMarkdown, buildDreamOrchestratorPrompt } from "./dream-prompts.js";
import { getAssistantSnapshot, listOtherOpenSessions, queueTelegramReset, resolveDreamTarget } from "./host-client.js";
import {
	ensureMemoryDirs,
	getLocalDateParts,
	getMemoryRootDir,
	resolveMemoryPath,
	writeMemoryFile,
	writeTelegramArchive,
} from "./store.js";
import { sessionConversationText, snapshotConversationText } from "./transcript.js";

export interface DreamToolParams {
	note?: string;
	threadId?: string;
	resetThread?: boolean;
	includeOpenSessions?: boolean;
}

export interface ToolTextResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function extractMarkdownField(text: string, field: string): string | undefined {
	const match = text.match(new RegExp(`^[-*]\\s+${field}\\s*:\\s*(.+)$`, "im"));
	return match?.[1]?.trim();
}

export function isTruthyMarkdownField(text: string, field: string): boolean {
	const value = extractMarkdownField(text, field)?.toLowerCase();
	return value === "true" || value === "yes" || value === "1";
}

export async function runDreamTool(pi: ExtensionAPI, params: DreamToolParams, ctx: any): Promise<ToolTextResult> {
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
	const orchestratorPrompt = buildDreamOrchestratorPrompt({
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
	});
	try {
		const orchestratorSession = directHost
			? await createDreamOrchestratorSession(directHost, modelRef)
			: await createRemoteDreamOrchestratorSession(hostUrl, modelRef);
		orchestratorSessionId = orchestratorSession.metadata.sessionId;
		orchestratorResponse = directHost
			? await promptDreamOrchestrator(orchestratorSession, modelRef, orchestratorPrompt)
			: await promptRemoteDreamOrchestrator(hostUrl, orchestratorSession.metadata.sessionId, modelRef, orchestratorPrompt);
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
}
