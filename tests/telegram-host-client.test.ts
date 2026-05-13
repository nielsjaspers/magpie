import { afterEach, describe, expect, test } from "bun:test";
import {
	getAssistantThreadSnapshot,
	getAssistantThreadStatus,
	resetAssistantThread,
	resolveAssistantThread,
	sendAssistantMessage,
} from "../apps/telegram/src/host-client.js";
import type { TelegramAppConfig } from "../apps/telegram/src/config.js";

const config: TelegramAppConfig = {
	botToken: "token",
	hostUrl: "http://127.0.0.1:8787",
	allowFrom: [],
	models: { default: "opencode/gpt-5" },
	showToolCalls: false,
	prompt: { customFiles: [] },
	configScope: "project",
	globalConfigPath: "/tmp/global.json",
	projectConfigPath: "/tmp/project.json",
	globalAuthPath: "/tmp/global-auth.json",
	projectAuthPath: "/tmp/project-auth.json",
	hostCwd: "/tmp",
	storageDir: "/tmp/magpie-telegram",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Telegram host client protocol", () => {
	test("uses generic hosted session endpoints", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof URL ? input : new URL(String(input));
			calls.push({
				method: init?.method ?? "GET",
				path: url.pathname,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const json = url.pathname.endsWith("/message")
				? { sessionId: "telegram:t1", text: "hi", accepted: { sessionId: "telegram:t1", accepted: true, queued: false, runState: "idle" } }
				: url.pathname.endsWith("/status")
					? { sessionId: "telegram:t1", runState: "idle", updatedAt: "now" }
					: url.pathname.endsWith("/snapshot")
						? { metadata: { sessionId: "telegram:t1" }, status: { sessionId: "telegram:t1" }, messages: [] }
						: { ok: true, sessionId: "telegram:t1", metadata: { sessionId: "telegram:t1" } };
			return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		await resolveAssistantThread(config, "t1", "opencode/gpt-5");
		await sendAssistantMessage(config, "t1", "hello", "opencode/gpt-5");
		await getAssistantThreadStatus(config, "t1", "opencode/gpt-5");
		await getAssistantThreadSnapshot(config, "t1", "opencode/gpt-5");
		await resetAssistantThread(config, "t1", "opencode/gpt-5");

		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"POST /api/v1/sessions",
			"POST /api/v1/sessions/telegram%3At1/message",
			"GET /api/v1/sessions/telegram%3At1/status",
			"GET /api/v1/sessions/telegram%3At1/snapshot",
			"POST /api/v1/sessions/telegram%3At1/reset",
		]);
		expect(calls.some((call) => call.path.includes("/api/v1/assistant"))).toBe(false);
		expect(calls[0].body).toMatchObject({ kind: "assistant", assistantChannel: "telegram", assistantThreadId: "t1" });
		expect(calls[1].body).toMatchObject({ text: "hello", source: "telegram" });
	});
});
