import type { TelegramAppConfig } from "./config.js";

export interface AssistantMessageStreamEvent {
	type: "text_delta" | "message_complete" | "tool_start" | "tool_end" | "status" | "error";
	delta?: string;
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
	const response = await fetch(url);
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
	});
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
	onEvent: (event: AssistantMessageStreamEvent) => void | Promise<void>,
	signal?: AbortSignal,
) {
	const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stream`, config.hostUrl);
	url.searchParams.set("modelRef", modelRef);
	const response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
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
				await onEvent(parsed as AssistantMessageStreamEvent);
			} catch {
				// ignore malformed SSE payloads
			}
		}
	}
}

export async function sendAssistantMessageStreaming(
	config: TelegramAppConfig,
	threadId: string,
	text: string,
	modelRef: string,
	onEvent: (event: AssistantMessageStreamEvent) => void | Promise<void>,
) {
	const resolved = await resolveAssistantThread(config, threadId, modelRef);
	const controller = new AbortController();
	const streamPromise = streamSessionEvents(config, resolved.sessionId, modelRef, onEvent, controller.signal)
		.catch(() => {
			// best-effort streaming bridge
		});
		const result = await sendAssistantMessage(config, threadId, text, modelRef);
		await new Promise((resolve) => setTimeout(resolve, 250));
		controller.abort();
		await streamPromise;
		return { ...result, sessionId: resolved.sessionId };
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
	let snapshot: {
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
	};
	try {
		snapshot = await getJson<{
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
		}>(config.hostUrl, "/api/v1/assistant/snapshot", { channel: "telegram", threadId, modelRef, limit });
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
