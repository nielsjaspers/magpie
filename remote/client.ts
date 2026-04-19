import type { DispatchPayload, FetchPayload } from "./types.js";
import type { SerializedSessionBundle } from "./transport.js";
import { deserializeSessionBundle } from "./transport.js";

async function requestJson<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(new URL(path, baseUrl), options);
	const json = await response.json();
	if (!response.ok) {
		throw new Error(typeof json?.error === "string" ? json.error : `Request failed: ${response.status}`);
	}
	return json as T;
}

export async function exportHostedSession(baseUrl: string, sessionId: string, modelRef?: string) {
	return await requestJson<SerializedSessionBundle>(baseUrl, `/api/v1/sessions/${encodeURIComponent(sessionId)}/export`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ modelRef }),
	});
}

export async function dispatchSession(
	baseUrl: string,
	payload: DispatchPayload,
	bundle: SerializedSessionBundle,
) {
	return await requestJson<{
		ok: boolean;
		sessionId: string;
		receivedAt: string;
	}>(baseUrl, "/api/v1/dispatch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload, bundle }),
	});
}

export async function listDispatchedSessions(baseUrl: string) {
	return await requestJson<{
		sessions: Array<{
			sessionId: string;
			createdAt: string;
			updatedAt: string;
			payload: DispatchPayload;
		}>;
	}>(baseUrl, "/api/v1/remote/sessions");
}

export async function fetchRemoteSession(baseUrl: string, payload: FetchPayload) {
	return await requestJson<{
		ok: boolean;
		sessionId: string;
		preparedAt: string;
		targetCwd?: string;
		bundle: SerializedSessionBundle;
	}>(baseUrl, `/api/v1/sessions/${encodeURIComponent(payload.sessionId)}/fetch`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

export async function importRemoteBundle(baseUrl: string, bundle: SerializedSessionBundle) {
	return await requestJson<{
		sessionId: string;
		metadata: { sessionId: string };
	}>(baseUrl, "/api/v1/remote/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ bundle }),
	});
}

export async function exportAndDispatchHostedSession(
	baseUrl: string,
	input: { sessionId: string; modelRef?: string; payload?: Partial<DispatchPayload> },
) {
	const bundle = await exportHostedSession(baseUrl, input.sessionId, input.modelRef);
	const payload: DispatchPayload = {
		sessionId: input.sessionId,
		dispatchedAt: new Date().toISOString(),
		...input.payload,
	};
	const dispatched = await dispatchSession(baseUrl, payload, bundle);
	return { payload, bundle, dispatched };
}

export async function fetchAndImportRemoteSession(baseUrl: string, payload: FetchPayload) {
	const fetched = await fetchRemoteSession(baseUrl, payload);
	const imported = await importRemoteBundle(baseUrl, fetched.bundle);
	return {
		fetched,
		imported,
		bundle: deserializeSessionBundle(fetched.bundle),
	};
}

export async function deleteFetchedRemoteSession(baseUrl: string, payload: FetchPayload) {
	return await requestJson<{
		ok: boolean;
		sessionId: string;
		archivedAt?: string;
	}>(baseUrl, `/api/v1/sessions/${encodeURIComponent(payload.sessionId)}`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}
