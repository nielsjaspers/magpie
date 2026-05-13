import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { createAssistantThreadKey, type AssistantSessionHost } from "../../runtime/assistant-session-host.js";
import { readBody, sendJson } from "../request.js";
import { normalizeAssistantChannel } from "./session.js";

export function ownerForAssistantChannel(hostId: string, channel?: "telegram" | "web" | "internal") {
	if (channel === "web") {
		return { kind: "remote_web" as const, hostId, displayName: "Remote web assistant session" };
	}
	if (channel === "telegram") {
		return { kind: "system" as const, hostId, displayName: "Telegram assistant session" };
	}
	return { kind: "system" as const, hostId, displayName: "Assistant session" };
}

export async function handleAssistantLegacyRoute(input: {
	host: AssistantSessionHost;
	defaultModelRef: string;
	req: IncomingMessage;
	res: ServerResponse;
	requestUrl: URL;
}): Promise<boolean> {
	const { host, defaultModelRef, req, res, requestUrl } = input;
	if (req.method === "GET" && requestUrl.pathname === "/api/v1/assistant/status") {
		const channel = requestUrl.searchParams.get("channel") || "telegram";
		const threadId = requestUrl.searchParams.get("threadId") || "";
		const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
		if (!threadId) {
			sendJson(res, 400, { error: "threadId is required" });
			return true;
		}
		const threadKey = createAssistantThreadKey(channel, threadId);
		sendJson(res, 200, await host.getThreadStatus(threadKey, modelRef));
		return true;
	}
	if (req.method === "GET" && requestUrl.pathname === "/api/v1/assistant/snapshot") {
		const channel = requestUrl.searchParams.get("channel") || "telegram";
		const threadId = requestUrl.searchParams.get("threadId") || "";
		const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
		const limit = Number(requestUrl.searchParams.get("limit") || 20);
		if (!threadId) {
			sendJson(res, 400, { error: "threadId is required" });
			return true;
		}
		const threadKey = createAssistantThreadKey(channel, threadId);
		sendJson(res, 200, await host.getThreadSnapshot(threadKey, modelRef, limit));
		return true;
	}
	if (req.method !== "POST" || !req.url) return false;

	if (req.url === "/api/v1/assistant/resolve") {
		const body = await readBody(req);
		const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
		const threadId = String(body.threadId || "");
		const modelRef = String(body.modelRef || defaultModelRef);
		const title = typeof body.title === "string" ? body.title : undefined;
		if (!threadId) {
			sendJson(res, 400, { error: "threadId is required" });
			return true;
		}
		const resolved = await host.resolveAssistantSession({
			kind: "assistant",
			origin: "assistant",
			assistantChannel: channel,
			assistantThreadId: threadId,
			workspaceMode: "none",
			title,
			modelRef,
			owner: ownerForAssistantChannel(host.hostId, channel),
		});
		sendJson(res, 200, {
			sessionId: resolved.sessionId,
			created: resolved.created,
			sessionFile: resolved.sessionFile,
			metadata: resolved.metadata,
		});
		return true;
	}

	if (req.url === "/api/v1/assistant/message") {
		const body = await readBody(req);
		const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
		const threadId = String(body.threadId || "");
		const text = String(body.text || "");
		const modelRef = String(body.modelRef || defaultModelRef);
		if (!threadId || !text) {
			sendJson(res, 400, { error: "threadId and text are required" });
			return true;
		}
		const threadKey = createAssistantThreadKey(channel, threadId);
		await host.resolveAssistantSession({
			kind: "assistant",
			origin: "assistant",
			assistantChannel: channel,
			assistantThreadId: threadId,
			workspaceMode: "none",
			modelRef,
			owner: ownerForAssistantChannel(host.hostId, channel),
		});
		await host.claimOwnership(threadKey, ownerForAssistantChannel(host.hostId, channel));
		const toolEvents: Array<{ type: "start" | "end"; toolName: string; args?: unknown; result?: string; isError?: boolean }> = [];
		const { accepted, result } = await host.promptSession(threadKey, { text, modelRef }, (event) => {
			if (event.type === "start") toolEvents.push({ type: "start", toolName: event.toolName, args: event.args });
			else toolEvents.push({ type: "end", toolName: event.toolName, result: event.result, isError: event.isError });
		});
		sendJson(res, 200, {
			text: result.text || "",
			sessionId: threadKey,
			accepted,
			toolEvents,
		});
		return true;
	}

	if (req.url === "/api/v1/assistant/reset") {
		const body = await readBody(req);
		const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
		const threadId = String(body.threadId || "");
		if (!threadId) {
			sendJson(res, 400, { error: "threadId is required" });
			return true;
		}
		const threadKey = createAssistantThreadKey(channel, threadId);
		await host.resetThread(threadKey);
		sendJson(res, 200, { ok: true });
		return true;
	}
	return false;
}
