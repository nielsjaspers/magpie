import type { SessionHost } from "../runtime/session-host-types.js";
import type { DispatchPayload, FetchPayload } from "./types.js";

export interface RemoteServerRuntime {
	host: SessionHost;
}

export function createRemoteServerRuntime(host: SessionHost): RemoteServerRuntime {
	return { host };
}

export async function listRemoteSessions(runtime: RemoteServerRuntime) {
	return await runtime.host.listSessions({ kind: "coding" });
}

export async function acceptDispatch(_runtime: RemoteServerRuntime, payload: DispatchPayload) {
	return {
		ok: true,
		sessionId: payload.sessionId,
		receivedAt: new Date().toISOString(),
	};
}

export async function prepareFetch(_runtime: RemoteServerRuntime, payload: FetchPayload) {
	return {
		ok: true,
		sessionId: payload.sessionId,
		preparedAt: new Date().toISOString(),
		targetCwd: payload.targetCwd,
	};
}
