import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { DeviceRecord } from "../../remote/types.js";
import { serializeSessionBundle } from "../../remote/transport.js";
import type { HostedSessionHandle, HostedSessionStatus } from "../../runtime/session-host-types.js";
import {
	getSessionIdFromRequestPath,
	readBody,
	sendJson,
	sendSseEvent,
	startSse,
} from "../request.js";
import type { SessionMessageRequest } from "../protocol.js";
import { parseMultipartFormData, saveAssistantSessionFiles, saveWorkspaceFiles } from "../uploads.js";

export async function handleSessionMemberRoute(input: {
	req: IncomingMessage;
	res: ServerResponse;
	requestUrl: URL;
	defaultModelRef: string;
	authenticatedDevice?: DeviceRecord;
	getSessionAny: (sessionId: string, modelRef?: string) => Promise<HostedSessionHandle | undefined>;
	getSessionStatusAny: (sessionId: string, modelRef?: string) => Promise<HostedSessionStatus | undefined>;
	getSessionSnapshotAny: (sessionId: string, modelRef?: string, limit?: number) => Promise<unknown>;
	subscribeAny: (sessionId: string, listener: (event: unknown) => void | Promise<void>, watcher: any, modelRef?: string) => Promise<() => void>;
	buildWatchersForRequest: (sessionId: string, device?: DeviceRecord) => any;
	promptAny: (sessionId: string, text: string, modelRef: string) => Promise<{ accepted: unknown; text: string; toolEvents?: unknown[] }>;
	interruptAny: (sessionId: string, modelRef?: string) => Promise<void>;
	resetAssistantSession: (sessionId: string) => Promise<void>;
	getCodingSession: (sessionId: string) => Promise<HostedSessionHandle | undefined>;
	getAssistantSession: (sessionId: string) => Promise<HostedSessionHandle | undefined>;
}): Promise<boolean> {
	const {
		req,
		res,
		requestUrl,
		defaultModelRef,
		authenticatedDevice,
		getSessionAny,
		getSessionStatusAny,
		getSessionSnapshotAny,
		subscribeAny,
		buildWatchersForRequest,
		promptAny,
		interruptAny,
		resetAssistantSession,
		getCodingSession,
		getAssistantSession,
	} = input;
	const sessionPath = getSessionIdFromRequestPath(requestUrl.pathname);
	if (!sessionPath) return false;
	if (req.method === "GET" && sessionPath.suffix === "/stream") {
		const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
		const status = await getSessionStatusAny(sessionPath.sessionId, modelRef);
		if (!status) {
			sendJson(res, 404, { error: "Session not found" });
			return true;
		}
		startSse(res);
		const unsubscribe = await subscribeAny(sessionPath.sessionId, async (event: unknown) => {
			sendSseEvent(res, event);
		}, buildWatchersForRequest(sessionPath.sessionId, authenticatedDevice), modelRef);
		const keepAlive = setInterval(() => {
			res.write(": keepalive\n\n");
		}, 15000);
		req.on("close", () => {
			clearInterval(keepAlive);
			unsubscribe();
			if (!res.writableEnded) res.end();
		});
		return true;
	}
	if (req.method === "POST" && sessionPath.suffix === "/export") {
		const body = await readBody(req);
		const modelRef = typeof body.modelRef === "string" && body.modelRef.trim() ? body.modelRef : defaultModelRef;
		try {
			const session = await getSessionAny(sessionPath.sessionId, modelRef);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return true;
			}
			const bundle = await session.export(modelRef);
			sendJson(res, 200, serializeSessionBundle(bundle));
			return true;
		} catch {
			sendJson(res, 404, { error: "Session not found" });
			return true;
		}
	}
	if (req.method === "GET" && (sessionPath.suffix === "" || sessionPath.suffix === "/status")) {
		const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
		const status = await getSessionStatusAny(sessionPath.sessionId, modelRef);
		if (!status) {
			sendJson(res, 404, { error: "Session not found" });
			return true;
		}
		sendJson(res, 200, status);
		return true;
	}
	if (req.method === "GET" && sessionPath.suffix === "/snapshot") {
		const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
		const limit = Number(requestUrl.searchParams.get("limit") || 20);
		const snapshot = await getSessionSnapshotAny(sessionPath.sessionId, modelRef, limit);
		if (!snapshot) {
			sendJson(res, 404, { error: "Session not found" });
			return true;
		}
		sendJson(res, 200, snapshot);
		return true;
	}
	if (req.method === "POST" && sessionPath.suffix === "/files") {
		try {
			const parts = await parseMultipartFormData(req);
			const fileParts = parts.filter((p) => p.filename);
			if (fileParts.length === 0) {
				sendJson(res, 400, { error: "No files uploaded" });
				return true;
			}
			const codingSession = await getCodingSession(sessionPath.sessionId);
			if (!codingSession) {
				const assistantSession = await getAssistantSession(sessionPath.sessionId);
				if (!assistantSession?.metadata.sourceSessionPath) {
					sendJson(res, 404, { error: "Session not found" });
					return true;
				}
				const results = await saveAssistantSessionFiles(
					assistantSession.metadata.sourceSessionPath,
					sessionPath.sessionId,
					fileParts.map((part) => ({ filename: part.filename, data: part.data })),
				);
				sendJson(res, 200, { ok: true, files: results });
				return true;
			}
			const workspaceDir = codingSession.metadata.cwd;
			const results = await saveWorkspaceFiles(
				workspaceDir,
				fileParts.map((part) => ({ filename: part.filename!, data: part.data })),
			);
			sendJson(res, 200, { ok: true, files: results });
			return true;
		} catch (err) {
			const statusCode = (err as { statusCode?: number }).statusCode;
			if (statusCode === 413) sendJson(res, 413, { error: (err as Error).message });
			else sendJson(res, 500, { error: (err as Error).message });
			return true;
		}
	}
	if (req.method === "POST" && sessionPath.suffix === "/message") {
		const body = await readBody(req) as unknown as Partial<SessionMessageRequest>;
		const text = String(body.text || "");
		const modelRef = String(body.modelRef || defaultModelRef);
		if (!text) {
			sendJson(res, 400, { error: "text is required" });
			return true;
		}
		const result = await promptAny(sessionPath.sessionId, text, modelRef);
		sendJson(res, 200, {
			text: result.text,
			sessionId: sessionPath.sessionId,
			accepted: result.accepted,
			toolEvents: result.toolEvents,
		});
		return true;
	}
	if (req.method === "POST" && sessionPath.suffix === "/interrupt") {
		const body = await readBody(req);
		const modelRef = String(body.modelRef || defaultModelRef);
		await interruptAny(sessionPath.sessionId, modelRef);
		sendJson(res, 200, { ok: true });
		return true;
	}
	if (req.method === "POST" && sessionPath.suffix === "/reset") {
		await resetAssistantSession(sessionPath.sessionId);
		sendJson(res, 200, { ok: true });
		return true;
	}
	return false;
}
