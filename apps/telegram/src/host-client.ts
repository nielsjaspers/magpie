import type { TelegramAppConfig } from "./config.js";

async function getJson<T>(baseUrl: string, path: string, params: Record<string, string | number | undefined>): Promise<T> {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	const response = await fetch(url);
	const json = await response.json();
	if (!response.ok) {
		throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`);
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
		throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`);
	}
	return json as T;
}

export async function resolveAssistantThread(config: TelegramAppConfig, threadId: string, modelRef: string) {
	return await postJson<{ sessionId: string; created: boolean; sessionFile?: string }>(
		config.hostUrl,
		"/api/v1/assistant/resolve",
		{ channel: "telegram", threadId, modelRef },
	);
}

export async function sendAssistantMessage(config: TelegramAppConfig, threadId: string, text: string, modelRef: string) {
	return await postJson<{
		text: string;
		sessionId: string;
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

export async function resetAssistantThread(config: TelegramAppConfig, threadId: string) {
	return await postJson<{ ok: boolean }>(
		config.hostUrl,
		"/api/v1/assistant/reset",
		{ channel: "telegram", threadId },
	);
}

export async function getAssistantThreadStatus(config: TelegramAppConfig, threadId: string, modelRef: string) {
	return await getJson<{
		threadKey: string;
		exists: boolean;
		sessionPath?: string;
		updatedAt?: string;
		loaded: boolean;
		messageCount?: number;
		sessionId?: string;
	}>(config.hostUrl, "/api/v1/assistant/status", {
		channel: "telegram",
		threadId,
		modelRef,
	});
}

export async function getAssistantThreadSnapshot(config: TelegramAppConfig, threadId: string, modelRef: string, limit = 20) {
	return await getJson<{
		threadKey: string;
		exists: boolean;
		sessionPath?: string;
		updatedAt?: string;
		loaded: boolean;
		messageCount?: number;
		sessionId?: string;
		messages?: Array<{ role: string; text?: string }>;
	}>(config.hostUrl, "/api/v1/assistant/snapshot", {
		channel: "telegram",
		threadId,
		modelRef,
		limit,
	});
}
