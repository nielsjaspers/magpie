import type { WebUiRouteRegistration } from "../webui/types.js";

const DISPATCH_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
import { buildRemoteBundleSnapshot } from "./snapshot.js";
import { acceptDispatch, createRemoteServerRuntime, deleteRemoteSession, getStoredRemoteBundle, listRemoteSessions, prepareFetch } from "./server.js";
import { deserializeSessionBundle } from "./transport.js";

export function buildRemoteWebUiRoutes(): WebUiRouteRegistration[] {
	return [{
		name: "remote-routes",
		handler: async ({ req, res, requestUrl, runtime, readBody, sendJson, getSessionIdFromRequestPath }) => {
			const webRuntime = runtime as {
				remote: ReturnType<typeof createRemoteServerRuntime>;
				codingHost: any;
				host: any;
				defaultModelRef: string;
			};
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/remote/sessions") {
				sendJson(res, 200, { sessions: await listRemoteSessions(webRuntime.remote) });
				return true;
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/dispatch") {
				const body = await readBody(req, DISPATCH_BODY_LIMIT_BYTES);
				sendJson(res, 201, await acceptDispatch(webRuntime.remote, webRuntime.codingHost, webRuntime.defaultModelRef, {
					payload: body.payload as any,
					bundle: body.bundle as any,
				}));
				return true;
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/remote/import") {
				const body = await readBody(req);
				const bundle = deserializeSessionBundle(body.bundle as any);
				const session = bundle.metadata.kind === "coding"
					? await webRuntime.codingHost.importSession({
						bundle,
						owner: {
							kind: "remote_web",
							hostId: webRuntime.codingHost.hostId,
							displayName: "Remote web session",
						},
					})
					: await webRuntime.host.importSession({ bundle });
				sendJson(res, 201, { sessionId: session.metadata.sessionId, metadata: session.metadata });
				return true;
			}
			const remoteMatch = requestUrl.pathname.match(/^\/api\/v1\/remote\/sessions\/([^/]+)$/);
			if (req.method === "GET" && remoteMatch?.[1]) {
				const sessionId = decodeURIComponent(remoteMatch[1]);
				const loaded = await getStoredRemoteBundle(webRuntime.remote, sessionId);
				if (!loaded) {
					sendJson(res, 404, { error: "Remote session not found" });
					return true;
				}
				sendJson(res, 200, buildRemoteBundleSnapshot(loaded.serialized, 80));
				return true;
			}
			const sessionPath = getSessionIdFromRequestPath(requestUrl.pathname);
			if (sessionPath && (req.method === "POST" || req.method === "GET") && sessionPath.suffix === "/fetch") {
				const body = req.method === "POST" ? await readBody(req) : {};
				sendJson(res, 200, await prepareFetch(webRuntime.remote, webRuntime.codingHost, {
					sessionId: sessionPath.sessionId,
					fetchedAt: new Date().toISOString(),
					targetCwd: typeof body.targetCwd === "string"
						? body.targetCwd
						: requestUrl.searchParams.get("targetCwd") || undefined,
				}));
				return true;
			}
			if (sessionPath && req.method === "DELETE" && sessionPath.suffix === "") {
				const body = await readBody(req);
				sendJson(res, 200, await deleteRemoteSession(webRuntime.remote, webRuntime.codingHost, {
					sessionId: sessionPath.sessionId,
					fetchedAt: new Date().toISOString(),
					targetCwd: typeof body.targetCwd === "string" ? body.targetCwd : undefined,
				}));
				return true;
			}
			return false;
		},
	}];
}
