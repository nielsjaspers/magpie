import { describe, expect, test } from "bun:test";
import { modelRefFromContext } from "../memory/dream-orchestrator.js";
import { buildDreamContextMarkdown, buildDreamOrchestratorPrompt } from "../memory/dream-prompts.js";
import { describeHostFetchError } from "../memory/host-client.js";

describe("memory dream prompt builders", () => {
	test("builds context with paths, email, and session summaries", () => {
		const markdown = buildDreamContextMarkdown({
			now: new Date("2026-01-01T00:00:00.000Z"),
			timezone: "UTC",
			dayStamp: "2026-01-01",
			timestampStamp: "20260101T000000Z",
			note: "focus",
			threadId: "thread-1",
			targetSource: "explicit",
			resetThread: true,
			telegramArchiveAbsolutePath: "/mem/archive.md",
			telegramArchiveRelativePath: "archive.md",
			phase1ArtifactRelativePath: "phase1.md",
			phase2ArtifactRelativePath: "phase2.md",
			phase3ArtifactRelativePath: "phase3.md",
			summaryRelativePath: "summary.md",
			digestRelativePath: "digest.md",
			reviewRelativePath: "review.md",
			planDocPath: "/plan.md",
			recentEmails: [{ id: "m1", threadId: "t1", from: "Ada", subject: "Hi", date: "2026", snippet: "Body", labels: [], isUnread: true }],
			otherSessions: [{ sessionId: "s1", kind: "coding", location: "local", runState: "idle", createdAt: "2026", updatedAt: "2026" }],
			rootDir: "/mem",
		});

		expect(markdown).toContain("- threadId: thread-1");
		expect(markdown).toContain("Ada");
		expect(markdown).toContain("s1");
	});

	test("builds orchestrator prompt with exact phase artifact targets", () => {
		const prompt = buildDreamOrchestratorPrompt({
			contextRelativePath: "context.md",
			contextAbsolutePath: "/mem/context.md",
			planDocPath: "/plan.md",
			phase1ArtifactAbsolutePath: "/mem/phase1.md",
			phase2ArtifactAbsolutePath: "/mem/phase2.md",
			phase3ArtifactAbsolutePath: "/mem/phase3.md",
			digestAbsolutePath: "/mem/digest.md",
			reviewAbsolutePath: "/mem/review.md",
			summaryRelativePath: "summary.md",
			rootDir: "/mem",
		});

		expect(prompt).toContain("exactly three sequential memory phase subagents");
		expect(prompt).toContain("/mem/phase1.md");
		expect(prompt).toContain("- shouldResetTelegramThread: true|false");
	});

	test("exposes host-client and orchestrator helper behavior", () => {
		expect(modelRefFromContext({ model: { provider: "opencode", id: "gpt-5" } })).toBe("opencode/gpt-5");
		expect(modelRefFromContext({ model: { provider: "opencode" } })).toBeUndefined();
		expect(describeHostFetchError(new URL("http://127.0.0.1:8787/api"), new Error("refused"))).toContain("telegram.hostUrl");
	});
});
