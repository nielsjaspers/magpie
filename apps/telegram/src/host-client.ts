import { Agent } from "undici";
import type { TelegramAppConfig } from "./config.js";

const hostDispatcher = new Agent({
	headersTimeout: 0,
	bodyTimeout: 0,
	connectTimeout: 30_000,
});

interface AssistantThreadSnapshotResponse {
	metadata: { sessionId: string };
	status: {
		sessionId: string;
		sessionPath?: string;
		updatedAt?: string;
		loaded?: boolean;
		messageCount?: number;
		createdAt?: string;
		runState?: "idle" | "running" | "aborting" | "error";
		queueDepth?: number;
		lastError?: string;
		assistantChannel?: string;
		assistantThreadId?: string;
	};
	messages: Array<{ role: string; text?: string }>;
}

interface HostedAssistantStreamEvent {
	type: "snapshot" | "status" | "text_delta" | "message_complete" | "tool_start" | "tool_end" | "error";
	session?: AssistantThreadSnapshotResponse;
	status?: unknown;
	delta?: string;
	message?: unknown;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	error?: string;
}

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
	const json = await response.json();
	if (!response.ok) {
		throw new HostRequestError(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`, response.status);
	}
	return json as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
	const response = await fetch(new URL(path, baseUrl), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		dispatcher: hostDispatcher as any,
	} as any);
	const json = await response.json();
	if (!response.ok) {
		throw new HostRequestError(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`, response.status);
	}
	return json as T;
}

export async function resolveAssistantThread(config: TelegramAppConfig, threadId: string, modelRef: string) {
	return await postJson<{
		sessionId: string;
		created: boolean;
		sessionFile?: string;
		metadata?: { sessionId: string };
	}>(
		config.hostUrl,
		"/api/v1/assistant/resolve",
		{ channel: "telegram", threadId, modelRef },
	);
}

function assistantSessionId(threadId: string): string {
	return `telegram:${threadId}`;
}

export async function sendAssistantMessage(config: TelegramAppConfig, threadId: string, text: string, modelRef: string) {
	return await postJson<{
		text: string;
		sessionId: string;
		accepted?: {
			sessionId: string;
			accepted: boolean;
			queued: boolean;
			runState: "idle" | "running" | "aborting" | "error";
		};
		toolEvents?: Array<{
			type: "start" | "end";
			toolName: string;
			args?: unknown;
			result?: string;
			isError?: boolean;
		}>;
	}>(
		config.hostUrl,
		"/api/v1/assistant/message",
		{ channel: "telegram", threadId, text, modelRef },
	);
}

async function streamSessionEvents(
	config: TelegramAppConfig,
	sessionId: string,
	modelRef: string,
	onEvent: (event: HostedAssistantStreamEvent) => void | Promise<void>,
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
				await onEvent(parsed as HostedAssistantStreamEvent);
			} catch {
				// ignore malformed SSE payloads
			}
		}
	}
}

function extractTextFromUnknownContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(content)) {
		const parts = content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object") {
					const record = part as Record<string, unknown>;
					if (typeof record.text === "string") return record.text;
					if (typeof record.content === "string") return record.content;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
		return parts || undefined;
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") {
			const trimmed = record.text.trim();
			return trimmed || undefined;
		}
		if (typeof record.content === "string") {
			const trimmed = record.content.trim();
			return trimmed || undefined;
		}
		if (Array.isArray(record.content)) return extractTextFromUnknownContent(record.content);
		if (record.message && typeof record.message === "object") {
			const nested = record.message as Record<string, unknown>;
			return extractTextFromUnknownContent(nested.content);
		}
	}
	return undefined;
}

function extractTextFromSessionMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	return extractTextFromUnknownContent(record.content)
		?? extractTextFromUnknownContent(record.message)
		?? extractTextFromUnknownContent(record.parts);
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
	return await postJson<{ ok: boolean }>(
		config.hostUrl,
		"/api/v1/assistant/reset",
		{ channel: "telegram", threadId },
	);
}

export async function getAssistantThreadStatus(config: TelegramAppConfig, threadId: string, modelRef: string) {
	let status: {
		sessionId: string;
		sessionPath?: string;
		updatedAt?: string;
		loaded?: boolean;
		messageCount?: number;
		createdAt?: string;
		runState?: "idle" | "running" | "aborting" | "error";
		queueDepth?: number;
		lastError?: string;
		assistantChannel?: string;
		assistantThreadId?: string;
	};
	try {
		status = await getJson<{
			sessionId: string;
			sessionPath?: string;
			updatedAt?: string;
			loaded?: boolean;
			messageCount?: number;
			createdAt?: string;
			runState?: "idle" | "running" | "aborting" | "error";
			queueDepth?: number;
			lastError?: string;
			assistantChannel?: string;
			assistantThreadId?: string;
		}>(config.hostUrl, "/api/v1/assistant/status", { channel: "telegram", threadId, modelRef });
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
	let snapshot: AssistantThreadSnapshotResponse;
	try {
		snapshot = await getJson<AssistantThreadSnapshotResponse>(config.hostUrl, "/api/v1/assistant/snapshot", { channel: "telegram", threadId, modelRef, limit });
	} catch (error) {
		if (error instanceof HostRequestError && error.status === 404) {
			return {
				threadKey: assistantSessionId(threadId),
				exists: false,
				loaded: false,
				messages: [],
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
