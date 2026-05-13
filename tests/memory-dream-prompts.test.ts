import { describe, expect, test } from "bun:test";
import { modelRefFromContext } from "../memory/dream-orchestrator.js";
import { extractMarkdownField, isTruthyMarkdownField } from "../memory/dream-runner.js";
import { buildDreamContextMarkdown, buildDreamOrchestratorPrompt } from "../memory/dream-prompts.js";
import { describeHostFetchError, getAssistantSnapshot, queueTelegramReset } from "../memory/host-client.js";
import { messageToText, snapshotConversationText } from "../memory/transcript.js";

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
		expect(messageToText([{ type: "text", text: "hi" }, { type: "image" }])).toBe("hi");
		expect(snapshotConversationText({ messages: [{ role: "assistant", text: "hello" }] } as any)).toContain("## assistant");
		expect(extractMarkdownField("- status: success", "status")).toBe("success");
		expect(isTruthyMarkdownField("- shouldResetTelegramThread: yes", "shouldResetTelegramThread")).toBe(true);
	});

	test("uses generic hosted session endpoints for Telegram host calls", async () => {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof URL ? input : new URL(String(input));
			calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
			return new Response(JSON.stringify({
				metadata: { sessionId: "telegram:t1" },
				status: { sessionId: "telegram:t1" },
				messages: [],
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		try {
			await getAssistantSnapshot("http://127.0.0.1:8787", "t1", 10);
			queueTelegramReset("http://127.0.0.1:8787", "t1");
			await new Promise((resolve) => setTimeout(resolve, 1600));
			expect(calls).toContain("GET /api/v1/sessions/telegram%3At1/snapshot");
			expect(calls).toContain("POST /api/v1/sessions/telegram%3At1/reset");
			expect(calls.some((call) => call.includes("/api/v1/assistant"))).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
