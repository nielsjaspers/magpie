import type { CodingSessionHost } from "../runtime/coding-session-host.js";
import type { DispatchPayload, FetchPayload } from "./types.js";
import type { SerializedSessionBundle } from "./transport.js";
import {
	archiveRemoteBundle,
	createRemoteBundleStore,
	listRemoteBundles,
	loadRemoteBundle,
	storeRemoteBundle,
	type RemoteBundleStore,
} from "./store.js";
import { deserializeSessionBundle, serializeSessionBundle } from "./transport.js";

export interface RemoteServerRuntime {
	store: RemoteBundleStore;
}

export function createRemoteServerRuntime(store = createRemoteBundleStore()): RemoteServerRuntime {
	return { store };
}

export async function listRemoteSessions(runtime: RemoteServerRuntime) {
	return await listRemoteBundles(runtime.store);
}

export async function acceptDispatch(
	runtime: RemoteServerRuntime,
	codingHost: CodingSessionHost,
	defaultModelRef: string,
	input: { payload: DispatchPayload; bundle: SerializedSessionBundle },
) {
	const bundle = deserializeSessionBundle(input.bundle);
	const metadata = await codingHost.importSession({ bundle });
	await storeRemoteBundle(runtime.store, input.payload, {
		...bundle,
		metadata: { ...bundle.metadata, location: "remote", remoteSessionId: metadata.sessionId },
	});
	const modelRef = input.payload.modelRef?.trim() || bundle.metadata.summary?.trim() || defaultModelRef;
	if (input.payload.note?.trim()) {
		void codingHost.sendUserMessage(metadata.sessionId, {
			text: input.payload.note.trim(),
			modelRef,
			source: "system",
		}).catch(() => {
			// surfaced via hosted session status/events
		});
	}
	return {
		ok: true,
		sessionId: metadata.sessionId,
		receivedAt: new Date().toISOString(),
		metadata,
	};
}

export async function prepareFetch(
	runtime: RemoteServerRuntime,
	codingHost: CodingSessionHost,
	payload: FetchPayload,
) {
	const exported = await codingHost.exportSession(payload.sessionId);
	return {
		ok: true,
		sessionId: payload.sessionId,
		preparedAt: new Date().toISOString(),
		targetCwd: payload.targetCwd,
		bundle: serializeSessionBundle(exported),
	};
}

export async function deleteRemoteSession(
	runtime: RemoteServerRuntime,
	codingHost: CodingSessionHost,
	payload: FetchPayload,
) {
	const exported = await codingHost.exportSession(payload.sessionId);
	const record = await archiveRemoteBundle(runtime.store, payload, exported);
	await codingHost.archiveSession(payload.sessionId);
	return {
		ok: true,
		sessionId: payload.sessionId,
		archivedAt: record?.archivedAt ?? new Date().toISOString(),
	};
}

export async function getStoredRemoteBundle(runtime: RemoteServerRuntime, sessionId: string) {
	return await loadRemoteBundle(runtime.store, sessionId);
}
