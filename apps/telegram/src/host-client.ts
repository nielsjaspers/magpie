import type { TelegramAppConfig } from "./config.js";

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
	return await postJson<{ text: string; sessionId: string }>(
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
