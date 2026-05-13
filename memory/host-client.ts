import { parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import type { HostedSessionSnapshot, HostedSessionSummary } from "../runtime/session-host-types.js";
import { readJsonResponse } from "../shared/http.js";

function assistantSessionId(threadId: string): string {
	return `telegram:${threadId}`;
}

export function describeHostFetchError(url: URL, error: unknown) {
	const reason = error instanceof Error ? error.message : String(error);
	return `Could not reach Magpie assistant host at ${url.toString()}: ${reason}. Ensure the webui/assistant host is running and telegram.hostUrl points to it from this machine.`;
}

export async function getJson<T>(baseUrl: string, path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new Error(describeHostFetchError(url, error));
	}
	return await readJsonResponse<T>(response, `for ${url.toString()}`);
}

export async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
	const url = new URL(path, baseUrl);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Error(describeHostFetchError(url, error));
	}
	return await readJsonResponse<T>(response, `for ${url.toString()}`);
}

export async function queueTelegramReset(hostUrl: string, threadId: string) {
	setTimeout(() => {
		void fetch(new URL(`/api/v1/sessions/${encodeURIComponent(assistantSessionId(threadId))}/reset`, hostUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}).catch(() => {
			// best-effort reset after dream response is delivered
		});
	}, 1500);
}

export async function resolveDreamTarget(hostUrl: string, explicitThreadId: string | undefined, currentSessionId: string | undefined) {
	if (explicitThreadId?.trim()) return { threadId: explicitThreadId.trim(), source: "explicit" as const };
	const parsedThread = typeof currentSessionId === "string" ? parseAssistantThreadKey(currentSessionId) : undefined;
	if (parsedThread?.channel === "telegram") return { threadId: parsedThread.threadId, source: "current-session" as const };
	const listed = await getJson<{ sessions: HostedSessionSummary[] }>(hostUrl, "/api/v1/sessions", {
		kind: "assistant",
		assistantChannel: "telegram",
		includeArchived: 0,
		limit: 10,
	});
	const target = listed.sessions
		.filter((session) => session.assistantThreadId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	if (!target?.assistantThreadId) throw new Error("No active Telegram assistant thread found.");
	return { threadId: target.assistantThreadId, source: "active-telegram" as const };
}

export async function getAssistantSnapshot(hostUrl: string, threadId: string, limit = 200) {
	return await getJson<HostedSessionSnapshot>(hostUrl, `/api/v1/sessions/${encodeURIComponent(assistantSessionId(threadId))}/snapshot`, {
		limit,
	});
}

export async function listOtherOpenSessions(hostUrl: string, currentSessionId: string | undefined, targetThreadId: string, include: boolean) {
	if (!include) return [] as HostedSessionSummary[];
	const listed = await getJson<{ sessions: HostedSessionSummary[] }>(hostUrl, "/api/v1/sessions", {
		includeArchived: 0,
		limit: 25,
	});
	return listed.sessions.filter((session) => {
		if (session.sessionId === currentSessionId) return false;
		if (session.assistantChannel === "telegram" && session.assistantThreadId === targetThreadId) return false;
		return session.location !== "archived";
	});
}
