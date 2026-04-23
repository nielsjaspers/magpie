import { describe, expect, test } from "bun:test";
import {
	createSessionRoute,
	getSessionSnapshotRoute,
	getSessionStatusRoute,
	listSessionRoute,
	normalizeAssistantChannel,
	parseCreateSessionInput,
	parseSendMessageInput,
	parseSessionFilter,
	sendSessionMessageRoute,
} from "../webui/routes/session.js";
import type { HostedSessionHandle, HostedSessionMetadata, HostedSessionStatus, SessionHost } from "../runtime/session-host-types.js";

describe("webui session route parsing", () => {
	test("normalizes assistant channels and parses filters", () => {
		expect(normalizeAssistantChannel("telegram")).toBe("telegram");
		expect(normalizeAssistantChannel("bad")).toBeUndefined();

		const filter = parseSessionFilter(new URLSearchParams("kind=assistant&location=archived&ownerKind=remote_web&assistantChannel=web&includeArchived=1&limit=25&query=abc"));
		expect(filter).toEqual({
			kind: "assistant",
			location: "archived",
			runState: undefined,
			ownerKind: "remote_web",
			assistantChannel: "web",
			query: "abc",
			includeArchived: true,
			limit: 25,
		});
	});

	test("parses create and send-message bodies with safe defaults", () => {
		expect(parseCreateSessionInput({ assistantChannel: "bad", toolNames: ["read", "", 3], modelRef: "" }, "opencode/gpt-5-nano")).toMatchObject({
			kind: "assistant",
			origin: "assistant",
			workspaceMode: "none",
			assistantChannel: "internal",
			modelRef: "opencode/gpt-5-nano",
			toolNames: ["read"],
		});
		expect(parseSendMessageInput({ text: 123, source: "web", modelRef: "" }, "opencode/gpt-5-nano")).toEqual({
			text: "123",
			source: "web",
			modelRef: "opencode/gpt-5-nano",
		});
	});
});

describe("webui session route handlers", () => {
	const metadata: HostedSessionMetadata = {
		sessionId: "s1",
		kind: "assistant",
		origin: "assistant",
		location: "remote",
		runState: "idle",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		workspaceMode: "none",
	};
	const status: HostedSessionStatus = {
		...metadata,
		watcherCount: 0,
	};
	const handle: HostedSessionHandle = {
		metadata,
		getPiSession: async () => ({}),
		getStatus: async () => status,
		getSnapshot: async () => ({ metadata, status, messages: [{ role: "assistant", text: "reply" }] }),
		subscribe: async () => () => {},
		sendUserMessage: async () => ({ sessionId: "s1", accepted: true, queued: false, runState: "idle" }),
		interrupt: async () => {},
		claimOwnership: async () => {},
		releaseOwnership: async () => {},
		archive: async () => {},
		export: async () => ({ metadata, sessionJsonl: new Uint8Array() }),
	};
	const host: SessionHost = {
		hostId: "h1",
		hostRole: "remote",
		getSession: async (sessionId) => sessionId === "s1" ? handle : undefined,
		createSession: async (input) => ({ ...handle, metadata: { ...metadata, ...input, sessionId: "created" } }),
		importSession: async () => handle,
		exportSession: async () => ({ metadata, sessionJsonl: new Uint8Array() }),
		sendUserMessage: async () => ({ sessionId: "s1", accepted: true, queued: false, runState: "idle" }),
		listSessions: async () => [status],
		getStatus: async () => status,
		getSnapshot: async () => ({ metadata, status, messages: [] }),
		subscribe: async () => () => {},
		interrupt: async () => {},
		claimOwnership: async () => {},
		releaseOwnership: async () => {},
		archiveSession: async () => {},
	};

	test("wraps host list/create/status/snapshot/send operations", async () => {
		expect(await listSessionRoute(host)).toEqual({ sessions: [status] });
		expect(await createSessionRoute(host, { kind: "assistant", origin: "assistant", modelRef: "opencode/gpt-5-nano" })).toMatchObject({ sessionId: "created" });
		expect(await getSessionStatusRoute(host, "s1")).toEqual(status);
		expect(await getSessionSnapshotRoute(host, "s1")).toMatchObject({ messages: [{ role: "assistant", text: "reply" }] });
		expect(await sendSessionMessageRoute(host, "s1", { text: "hello", modelRef: "opencode/gpt-5-nano" })).toMatchObject({ sessionId: "s1", text: "reply" });
	});

	test("rejects coding creation on assistant route and missing sessions", async () => {
		await expect(createSessionRoute(host, { kind: "coding", origin: "remote" })).rejects.toThrow("Only assistant session creation");
		await expect(getSessionStatusRoute(host, "missing")).rejects.toThrow("Session not found: missing");
	});
});
