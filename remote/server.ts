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
import { deserializeSessionBundle } from "./transport.js";

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
	input: { payload: DispatchPayload; bundle: SerializedSessionBundle },
) {
	const bundle = deserializeSessionBundle(input.bundle);
	const record = await storeRemoteBundle(runtime.store, input.payload, bundle);
	return {
		ok: true,
		sessionId: record.sessionId,
		receivedAt: record.updatedAt,
		record,
	};
}

export async function prepareFetch(runtime: RemoteServerRuntime, payload: FetchPayload) {
	const loaded = await loadRemoteBundle(runtime.store, payload.sessionId);
	if (!loaded) throw new Error(`Remote session not found: ${payload.sessionId}`);
	return {
		ok: true,
		sessionId: loaded.record.sessionId,
		preparedAt: new Date().toISOString(),
		targetCwd: payload.targetCwd,
		record: loaded.record,
		bundle: loaded.serialized,
	};
}

export async function deleteRemoteSession(runtime: RemoteServerRuntime, payload: FetchPayload) {
	const record = await archiveRemoteBundle(runtime.store, payload);
	if (!record) throw new Error(`Remote session not found: ${payload.sessionId}`);
	return {
		ok: true,
		sessionId: record.sessionId,
		archivedAt: record.archivedAt,
	};
}
