import type { HostedSessionSummary } from "../runtime/session-host-types.js";
import type { PaEmailSummary } from "../pa/shared/types.js";

function formatEmailSummaries(emails: PaEmailSummary[]): string {
	if (emails.length === 0) return "Recent email summaries: none.";
	return [
		"Recent email summaries:",
		...emails.map((email) => [
			`- ${email.date}`,
			email.from,
			email.subject,
			email.snippet,
		].filter(Boolean).join(" | ")),
	].join("\n");
}

function formatSessionSummaries(sessions: HostedSessionSummary[]): string {
	if (sessions.length === 0) return "Other open sessions: none.";
	return [
		"Other open sessions:",
		...sessions.map((session) => [
			`- ${session.sessionId}`,
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

export function buildDreamContextMarkdown(input: {
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

export function buildDreamOrchestratorPrompt(input: {
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
		"Use memory_subagent for phase delegation; do not delegate the phase work through unrelated tools.",
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
