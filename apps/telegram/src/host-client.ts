import { Agent } from "undici";
import type { TelegramAppConfig } from "./config.js";
import { httpResponseErrorMessage, parseJsonOrTextResponse } from "../../../shared/http.js";
import { extractTextFromSessionMessage } from "../../../runtime/session-content.js";
import type {
	SessionCreateResponse,
	SessionMessageResponse,
	SessionSnapshotResponse,
	SessionStatusResponse,
	SessionStreamEvent,
} from "../../../webui/protocol.js";

const hostDispatcher = new Agent({
	headersTimeout: 0,
	bodyTimeout: 0,
	connectTimeout: 30_000,
});

export interface AssistantSessionDeliveryEvent {
	type: "assistant_message" | "tool_start" | "tool_end" | "status" | "error";
	text?: string;
	message?: unknown;
	toolName?: string;
	args?: unknown;
	result?: string;
	isError?: boolean;
	status?: unknown;
	error?: string;
}

class HostRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

async function getJson<T>(baseUrl: string, path: string, params: Record<string, string | number | undefined>): Promise<T> {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	const response = await fetch(url, { dispatcher: hostDispatcher as any } as any);
	const parsed = await parseJsonOrTextResponse(response);
	if (!response.ok) {
		throw new HostRequestError(httpResponseErrorMessage(parsed, `for ${url.toString()}`), response.status);
	}
	if (parsed.json === undefined) throw new HostRequestError(`Expected JSON response for ${url.toString()}`, response.status);
	return parsed.json as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
	const url = new URL(path, baseUrl);
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		dispatcher: hostDispatcher as any,
	} as any);
	const parsed = await parseJsonOrTextResponse(response);
	if (!response.ok) {
		throw new HostRequestError(httpResponseErrorMessage(parsed, `for ${url.toString()}`), response.status);
	}
	if (parsed.json === undefined) throw new HostRequestError(`Expected JSON response for ${url.toString()}`, response.status);
	return parsed.json as T;
}

export async function resolveAssistantThread(config: TelegramAppConfig, threadId: string, modelRef: string) {
	return await postJson<SessionCreateResponse>(
		config.hostUrl,
		"/api/v1/sessions",
		{ kind: "assistant", origin: "assistant", assistantChannel: "telegram", assistantThreadId: threadId, workspaceMode: "none", modelRef },
	);
}

function assistantSessionId(threadId: string): string {
	return `telegram:${threadId}`;
}

export async function sendAssistantMessage(config: TelegramAppConfig, threadId: string, text: string, modelRef: string) {
	const sessionId = assistantSessionId(threadId);
	return await postJson<SessionMessageResponse>(
		config.hostUrl,
		`/api/v1/sessions/${encodeURIComponent(sessionId)}/message`,
		{ text, modelRef, source: "telegram" },
	);
}

async function streamSessionEvents(
	config: TelegramAppConfig,
	sessionId: string,
	modelRef: string,
	onEvent: (event: SessionStreamEvent) => void | Promise<void>,
	signal?: AbortSignal,
) {
	const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stream`, config.hostUrl);
	url.searchParams.set("modelRef", modelRef);
	const response = await fetch(url, { headers: { accept: "text/event-stream" }, signal, dispatcher: hostDispatcher as any } as any);
	if (!response.ok || !response.body) throw new HostRequestError(`Stream failed: ${response.status}`, response.status);
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let idx;
		while ((idx = buffer.indexOf("\n\n")) >= 0) {
			const rawEvent = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLines = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
			if (dataLines.length === 0) continue;
			try {
				const parsed = JSON.parse(dataLines.join("\n"));
				await onEvent(parsed as SessionStreamEvent);
			} catch {
				// ignore malformed SSE payloads
			}
		}
	}
}

function assistantMessageTexts(messages: Array<{ role: string; text?: string }>): string[] {
	return messages
		.filter((message) => message.role === "assistant" && typeof message.text === "string")
		.map((message) => message.text?.trim() || "")
		.filter(Boolean);
}

function overlapLength(previous: string[], next: string[]): number {
	const max = Math.min(previous.length, next.length);
	for (let size = max; size >= 0; size--) {
		let matches = true;
		for (let i = 0; i < size; i++) {
			if (previous[previous.length - size + i] !== next[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return size;
	}
	return 0;
}

export async function sendAssistantMessageWithEvents(
	config: TelegramAppConfig,
	threadId: string,
	text: string,
	modelRef: string,
	onEvent: (event: AssistantSessionDeliveryEvent) => void | Promise<void>,
) {
	const resolved = await resolveAssistantThread(config, threadId, modelRef);
	let knownAssistantMessages: string[] = [];
	try {
		const snapshot = await getAssistantThreadSnapshot(config, threadId, modelRef, 200);
		knownAssistantMessages = assistantMessageTexts(snapshot.messages ?? []);
	} catch {
		// best-effort baseline only
	}

	let deliveredAssistantMessages = 0;
	const emitAssistantText = async (messageText: string, message?: unknown) => {
		const trimmed = messageText.trim();
		if (!trimmed) return;
		deliveredAssistantMessages += 1;
		await onEvent({ type: "assistant_message", text: trimmed, message });
	};

	const emitNewAssistantMessagesFromSnapshot = async (fallbackMessage?: unknown) => {
		try {
			const snapshot = await getAssistantThreadSnapshot(config, threadId, modelRef, 200);
			const nextAssistantMessages = assistantMessageTexts(snapshot.messages ?? []);
			const overlap = overlapLength(knownAssistantMessages, nextAssistantMessages);
			const pending = nextAssistantMessages.slice(overlap);
			knownAssistantMessages = nextAssistantMessages;
			for (const pendingMessage of pending) {
				await emitAssistantText(pendingMessage);
			}
			if (pending.length > 0) return;
		} catch {
			// fall back to event payload below
		}
		const fallbackText = extractTextFromSessionMessage(fallbackMessage);
		if (!fallbackText) return;
		if (knownAssistantMessages.at(-1) === fallbackText.trim()) return;
		knownAssistantMessages = [...knownAssistantMessages, fallbackText.trim()].slice(-200);
		await emitAssistantText(fallbackText, fallbackMessage);
	};

	const controller = new AbortController();
	const streamPromise = streamSessionEvents(config, resolved.sessionId, modelRef, async (event) => {
		if (event.type === "message_complete") {
			await emitNewAssistantMessagesFromSnapshot(event.message);
			return;
		}
		if (event.type === "tool_start") {
			await onEvent({ type: "tool_start", toolName: event.toolName, args: event.args });
			return;
		}
		if (event.type === "tool_end") {
			const resultText = typeof event.result === "string"
				? event.result
				: event.result === undefined
					? undefined
					: JSON.stringify(event.result);
			await onEvent({ type: "tool_end", toolName: event.toolName, result: resultText, isError: event.isError });
			return;
		}
		if (event.type === "status") {
			await onEvent({ type: "status", status: event.status });
			return;
		}
		if (event.type === "error") {
			await onEvent({ type: "error", error: event.error });
		}
	}, controller.signal).catch(() => {
		// best-effort event bridge
	});

	try {
		const result = await sendAssistantMessage(config, threadId, text, modelRef);
		await emitNewAssistantMessagesFromSnapshot();
		await new Promise((resolve) => setTimeout(resolve, 250));
		await emitNewAssistantMessagesFromSnapshot();
		if (deliveredAssistantMessages === 0 && result.text?.trim()) {
			await emitAssistantText(result.text);
		}
		return { ...result, sessionId: resolved.sessionId };
	} finally {
		controller.abort();
		await streamPromise;
	}
}

export async function resetAssistantThread(config: TelegramAppConfig, threadId: string, _modelRef: string) {
	const sessionId = assistantSessionId(threadId);
	return await postJson<{ ok: boolean }>(
		config.hostUrl,
		`/api/v1/sessions/${encodeURIComponent(sessionId)}/reset`,
		{},
	);
}

export async function getAssistantThreadStatus(config: TelegramAppConfig, threadId: string, modelRef: string) {
	let status: SessionStatusResponse;
	try {
		status = await getJson<SessionStatusResponse>(config.hostUrl, `/api/v1/sessions/${encodeURIComponent(assistantSessionId(threadId))}/status`, { modelRef });
	} catch (error) {
		if (error instanceof HostRequestError && error.status === 404) {
			return {
				threadKey: assistantSessionId(threadId),
				exists: false,
				loaded: false,
			};
		}
		throw error;
	}
	return {
		threadKey: assistantSessionId(threadId),
		exists: true,
		sessionPath: status.sessionPath,
		updatedAt: status.updatedAt,
		loaded: Boolean(status.loaded),
		messageCount: status.messageCount,
		sessionId: status.sessionId,
		createdAt: status.createdAt,
		runState: status.runState,
		queueDepth: status.queueDepth,
		lastError: status.lastError,
		assistantChannel: status.assistantChannel,
		assistantThreadId: status.assistantThreadId,
	};
}

export async function getAssistantThreadSnapshot(config: TelegramAppConfig, threadId: string, modelRef: string, limit = 20) {
	let snapshot: SessionSnapshotResponse;
	try {
		snapshot = await getJson<SessionSnapshotResponse>(config.hostUrl, `/api/v1/sessions/${encodeURIComponent(assistantSessionId(threadId))}/snapshot`, { modelRef, limit });
	} catch (error) {
		if (error instanceof HostRequestError && error.status === 404) {
				return {
					threadKey: assistantSessionId(threadId),
					exists: false,
					loaded: false,
					messages: [] as Array<{ role: string; text?: string }>,
				};
		}
		throw error;
	}
	return {
		threadKey: assistantSessionId(threadId),
		exists: true,
		sessionPath: snapshot.status.sessionPath,
		updatedAt: snapshot.status.updatedAt,
		loaded: Boolean(snapshot.status.loaded),
		messageCount: snapshot.status.messageCount,
		sessionId: snapshot.status.sessionId,
		createdAt: snapshot.status.createdAt,
		runState: snapshot.status.runState,
		queueDepth: snapshot.status.queueDepth,
		lastError: snapshot.status.lastError,
		assistantChannel: snapshot.status.assistantChannel,
		assistantThreadId: snapshot.status.assistantThreadId,
		messages: snapshot.messages,
	};
}
