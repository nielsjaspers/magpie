import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getPersonalAssistantStorageDir, getTelegramConfig, getWebUiConfig, loadConfig } from "../config/config.js";
import { AssistantSessionHost, createAssistantThreadKey } from "../runtime/assistant-session-host.js";
import {
	acceptDispatch,
	createRemoteServerRuntime,
	deleteRemoteSession,
	listRemoteSessions,
	prepareFetch,
} from "../remote/server.js";
import {
	authenticateRequest,
	consumeEnrollmentCode,
	createRemoteAuthStore,
	isLoopbackRequest,
} from "../remote/auth.js";
import { buildRemoteBundleSnapshot } from "../remote/snapshot.js";
import { deserializeSessionBundle, serializeSessionBundle } from "../remote/transport.js";
import { loadRemoteBundle } from "../remote/store.js";
import {
	createSessionRoute,
	getSessionSnapshotRoute,
	getSessionStatusRoute,
	listSessionRoute,
	normalizeAssistantChannel,
	parseCreateSessionInput,
	parseSessionFilter,
} from "./routes/session.js";
import type { WebUiServerConfig } from "./types.js";

export interface WebUiServerRuntime {
	host: AssistantSessionHost;
	remote: ReturnType<typeof createRemoteServerRuntime>;
	auth: ReturnType<typeof createRemoteAuthStore>;
	defaultModelRef: string;
	hostUrl: string;
	config?: WebUiServerConfig;
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash < 0 || slash === 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

function resolveModel(ref: string) {
	const parsed = parseModelRef(ref);
	if (!parsed) throw new Error(`Invalid model ref: ${ref}`);
	const model = modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) throw new Error(`Model not found: ${ref}`);
	return model;
}

async function tryReadText(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

export async function loadWebUiServerRuntime(cwd: string, config?: WebUiServerConfig): Promise<WebUiServerRuntime> {
	const loadedConfig = await loadConfig(cwd);
	const telegram = getTelegramConfig(loadedConfig);
	const webui = getWebUiConfig(loadedConfig);
	const models = telegram?.models ?? {};
	const defaultModelRef = Object.values(models)[0];
	if (!defaultModelRef) throw new Error("telegram.models is empty in magpie.json");

	const projectConfigPath = resolve(cwd, ".pi/magpie.json");
	const globalConfigPath = resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME || "", ".pi/agent"), "magpie.json");
	const projectBaseDir = dirname(projectConfigPath);
	const globalBaseDir = dirname(globalConfigPath);
	const prompt = telegram?.prompt;

	const buildSystemPrompt = async () => {
		const parts: string[] = [];
		const readScoped = async (relativePath: string | undefined) => {
			if (!relativePath?.trim()) return undefined;
			return (await tryReadText(resolve(projectBaseDir, relativePath))) ??
				(await tryReadText(resolve(globalBaseDir, relativePath)));
		};
		const systemContent = await readScoped(prompt?.systemFile);
		if (systemContent?.trim()) parts.push(systemContent.trim());
		const memoryContent = await readScoped(prompt?.memoryFile);
		if (memoryContent?.trim()) parts.push(`## Memory\n${memoryContent.trim()}`);
		const userContent = await readScoped(prompt?.userFile);
		if (userContent?.trim()) parts.push(`## User Context\n${userContent.trim()}`);
		for (const path of prompt?.customFiles ?? []) {
			const content = await readScoped(path);
			if (content?.trim()) parts.push(content.trim());
		}
		return parts.length > 0
			? parts.join("\n\n")
			: "You are a helpful general-purpose assistant. Be concise, clear, and direct. You are accessed through a Telegram bot.";
	};

	const host = new AssistantSessionHost({
		hostCwd: cwd,
		storageDir: resolve(getPersonalAssistantStorageDir(loadedConfig), "telegram"),
		authStorage,
		modelRegistry,
		resolveModel,
		buildSystemPrompt,
		tools: [],
		hostId: "magpie-remote-host",
		hostRole: "remote",
	});

	return {
		host,
		remote: createRemoteServerRuntime(),
		auth: createRemoteAuthStore(),
		defaultModelRef,
		hostUrl: webui?.publicUrl?.trim() || webui?.tailscaleUrl?.trim() || telegram?.hostUrl?.trim() || config?.tailscaleUrl?.trim() || "http://127.0.0.1:8787",
		config: { ...webui, ...config },
	};
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => { data += chunk; });
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function startSse(res: ServerResponse) {
	res.statusCode = 200;
	res.setHeader("content-type", "text/event-stream; charset=utf-8");
	res.setHeader("cache-control", "no-cache, no-transform");
	res.setHeader("connection", "keep-alive");
	res.setHeader("x-accel-buffering", "no");
	res.write(": connected\n\n");
}

function sendSseEvent(res: ServerResponse, event: unknown) {
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function getSessionIdFromRequestPath(pathname: string): { sessionId: string; suffix: string } | undefined {
	const prefix = "/api/v1/sessions/";
	if (!pathname.startsWith(prefix)) return undefined;
	const rest = pathname.slice(prefix.length);
	if (!rest) return undefined;
	const slash = rest.indexOf("/");
	if (slash < 0) return { sessionId: decodeURIComponent(rest), suffix: "" };
	return {
		sessionId: decodeURIComponent(rest.slice(0, slash)),
		suffix: rest.slice(slash),
	};
}

export function createWebUiServer(runtime: WebUiServerRuntime): Server {
	const { host, remote, auth, defaultModelRef, hostUrl } = runtime;
	const clientDir = resolve(import.meta.dirname, "client");
	return createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url || "/", hostUrl);
			const isPublicPath = requestUrl.pathname === "/health" || requestUrl.pathname === "/enroll" || requestUrl.pathname === "/api/v1/enroll";
			if (!isPublicPath && !isLoopbackRequest(req)) {
				const device = await authenticateRequest(auth, req);
				if (!device) {
					if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/assets/")) {
						res.statusCode = 302;
						res.setHeader("location", "/enroll");
						res.end();
						return;
					}
					return sendJson(res, 401, { error: "Unauthorized" });
				}
			}
			if (req.method === "GET" && requestUrl.pathname === "/health") {
				return sendJson(res, 200, { ok: true, hostId: host.hostId, hostRole: host.hostRole });
			}
			if (req.method === "GET" && requestUrl.pathname === "/enroll") {
				res.statusCode = 200;
				res.setHeader("content-type", "text/html; charset=utf-8");
				res.end(await readFile(resolve(clientDir, "enroll.html"), "utf8"));
				return;
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll") {
				const body = await readBody(req);
				const result = await consumeEnrollmentCode(auth, {
					code: String(body.code || ""),
					deviceName: String(body.deviceName || "device"),
					platform: String(body.platform || req.headers["user-agent"] || "web"),
				});
				res.setHeader("set-cookie", `magpie_token=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax`);
				return sendJson(res, 200, { ok: true, device: result.device });
			}
			if (req.method === "GET" && requestUrl.pathname === "/") {
				res.statusCode = 200;
				res.setHeader("content-type", "text/html; charset=utf-8");
				res.end(await readFile(resolve(clientDir, "index.html"), "utf8"));
				return;
			}
			if (req.method === "GET" && requestUrl.pathname === "/assets/app.js") {
				res.statusCode = 200;
				res.setHeader("content-type", "text/javascript; charset=utf-8");
				res.end(await readFile(resolve(clientDir, "app.js"), "utf8"));
				return;
			}

			if (req.method === "GET" && requestUrl.pathname === "/api/v1/sessions") {
				return sendJson(res, 200, await listSessionRoute(host, parseSessionFilter(requestUrl.searchParams)));
			}
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/remote/sessions") {
				return sendJson(res, 200, { sessions: await listRemoteSessions(remote) });
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/dispatch") {
				const body = await readBody(req);
				return sendJson(res, 201, await acceptDispatch(remote, {
					payload: body.payload as any,
					bundle: body.bundle as any,
				}));
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/remote/import") {
				const body = await readBody(req);
				const metadata = await host.importSession({ bundle: deserializeSessionBundle(body.bundle as any) });
				return sendJson(res, 201, { sessionId: metadata.sessionId, metadata });
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/sessions") {
				const body = await readBody(req);
				const input = parseCreateSessionInput(body, defaultModelRef);
				if (input.kind !== "assistant") {
					return sendJson(res, 400, { error: "Only assistant session creation is supported by the current host" });
				}
				return sendJson(res, 201, await createSessionRoute(host, input));
			}

			const remoteMatch = requestUrl.pathname.match(/^\/api\/v1\/remote\/sessions\/([^/]+)$/);
			if (req.method === "GET" && remoteMatch?.[1]) {
				const sessionId = decodeURIComponent(remoteMatch[1]);
				const loaded = await loadRemoteBundle(remote.store, sessionId);
				if (!loaded) return sendJson(res, 404, { error: "Remote session not found" });
				return sendJson(res, 200, buildRemoteBundleSnapshot(loaded.serialized, 80));
			}

			const sessionPath = getSessionIdFromRequestPath(requestUrl.pathname);
			if (sessionPath && req.method === "GET" && sessionPath.suffix === "/stream") {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const status = await host.getStatus(sessionPath.sessionId, modelRef);
				if (!status) return sendJson(res, 404, { error: "Session not found" });
				startSse(res);
				const unsubscribe = await host.subscribe(sessionPath.sessionId, async (event) => {
					sendSseEvent(res, event);
				}, modelRef);
				const keepAlive = setInterval(() => {
					res.write(": keepalive\n\n");
				}, 15000);
				req.on("close", () => {
					clearInterval(keepAlive);
					unsubscribe();
					if (!res.writableEnded) res.end();
				});
				return;
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/export") {
				const body = await readBody(req);
				const modelRef = typeof body.modelRef === "string" && body.modelRef.trim() ? body.modelRef : defaultModelRef;
				try {
					return sendJson(res, 200, serializeSessionBundle(await host.exportSession(sessionPath.sessionId, modelRef)));
				} catch {
					return sendJson(res, 404, { error: "Session not found" });
				}
			}
			if (sessionPath && req.method === "GET" && sessionPath.suffix === "") {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				try {
					return sendJson(res, 200, await getSessionStatusRoute(host, sessionPath.sessionId, modelRef));
				} catch {
					return sendJson(res, 404, { error: "Session not found" });
				}
			}
			if (sessionPath && req.method === "GET" && sessionPath.suffix === "/snapshot") {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const limit = Number(requestUrl.searchParams.get("limit") || 20);
				try {
					return sendJson(res, 200, await getSessionSnapshotRoute(host, sessionPath.sessionId, modelRef, limit));
				} catch {
					return sendJson(res, 404, { error: "Session not found" });
				}
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/fetch") {
				const body = await readBody(req);
				return sendJson(res, 200, await prepareFetch(remote, {
					sessionId: sessionPath.sessionId,
					fetchedAt: new Date().toISOString(),
					targetCwd: typeof body.targetCwd === "string" ? body.targetCwd : undefined,
				}));
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/message") {
				const body = await readBody(req);
				const text = String(body.text || "");
				const modelRef = String(body.modelRef || defaultModelRef);
				if (!text) return sendJson(res, 400, { error: "text is required" });
				const toolEvents: Array<{ type: "start" | "end"; toolName: string; args?: unknown; result?: string; isError?: boolean }> = [];
				const { accepted, result } = await host.promptSession(sessionPath.sessionId, { text, modelRef }, (event) => {
					if (event.type === "start") toolEvents.push({ type: "start", toolName: event.toolName, args: event.args });
					else toolEvents.push({ type: "end", toolName: event.toolName, result: event.result, isError: event.isError });
				});
				return sendJson(res, 200, {
					text: result.text || "",
					sessionId: sessionPath.sessionId,
					accepted,
					toolEvents,
				});
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/interrupt") {
				const body = await readBody(req);
				const modelRef = String(body.modelRef || defaultModelRef);
				await host.interrupt(sessionPath.sessionId, modelRef);
				return sendJson(res, 200, { ok: true });
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/reset") {
				await host.resetSession(sessionPath.sessionId);
				return sendJson(res, 200, { ok: true });
			}
			if (sessionPath && req.method === "DELETE" && sessionPath.suffix === "") {
				const body = await readBody(req);
				return sendJson(res, 200, await deleteRemoteSession(remote, {
					sessionId: sessionPath.sessionId,
					fetchedAt: new Date().toISOString(),
					targetCwd: typeof body.targetCwd === "string" ? body.targetCwd : undefined,
				}));
			}

			if (req.method === "GET" && requestUrl.pathname === "/api/v1/assistant/status") {
				const channel = requestUrl.searchParams.get("channel") || "telegram";
				const threadId = requestUrl.searchParams.get("threadId") || "";
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				if (!threadId) return sendJson(res, 400, { error: "threadId is required" });
				const threadKey = createAssistantThreadKey(channel, threadId);
				return sendJson(res, 200, await host.getThreadStatus(threadKey, modelRef));
			}
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/assistant/snapshot") {
				const channel = requestUrl.searchParams.get("channel") || "telegram";
				const threadId = requestUrl.searchParams.get("threadId") || "";
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const limit = Number(requestUrl.searchParams.get("limit") || 20);
				if (!threadId) return sendJson(res, 400, { error: "threadId is required" });
				const threadKey = createAssistantThreadKey(channel, threadId);
				return sendJson(res, 200, await host.getThreadSnapshot(threadKey, modelRef, limit));
			}

			if (req.method !== "POST" || !req.url) {
				return sendJson(res, 404, { error: "Not found" });
			}

			if (req.url === "/api/v1/assistant/resolve") {
				const body = await readBody(req);
				const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
				const threadId = String(body.threadId || "");
				const modelRef = String(body.modelRef || defaultModelRef);
				const title = typeof body.title === "string" ? body.title : undefined;
				if (!threadId) return sendJson(res, 400, { error: "threadId is required" });
				const resolved = await host.resolveAssistantSession({
					kind: "assistant",
					origin: "assistant",
					assistantChannel: channel,
					assistantThreadId: threadId,
					workspaceMode: "none",
					title,
					modelRef,
				});
				return sendJson(res, 200, {
					sessionId: resolved.sessionId,
					created: resolved.created,
					sessionFile: resolved.sessionFile,
					metadata: resolved.metadata,
				});
			}

			if (req.url === "/api/v1/assistant/message") {
				const body = await readBody(req);
				const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
				const threadId = String(body.threadId || "");
				const text = String(body.text || "");
				const modelRef = String(body.modelRef || defaultModelRef);
				if (!threadId || !text) return sendJson(res, 400, { error: "threadId and text are required" });
				const threadKey = createAssistantThreadKey(channel, threadId);
				const toolEvents: Array<{ type: "start" | "end"; toolName: string; args?: unknown; result?: string; isError?: boolean }> = [];
				const { accepted, result } = await host.promptSession(threadKey, { text, modelRef }, (event) => {
					if (event.type === "start") toolEvents.push({ type: "start", toolName: event.toolName, args: event.args });
					else toolEvents.push({ type: "end", toolName: event.toolName, result: event.result, isError: event.isError });
				});
				return sendJson(res, 200, {
					text: result.text || "",
					sessionId: threadKey,
					accepted,
					toolEvents,
				});
			}

			if (req.url === "/api/v1/assistant/reset") {
				const body = await readBody(req);
				const channel = normalizeAssistantChannel(String(body.channel || "telegram")) || "telegram";
				const threadId = String(body.threadId || "");
				if (!threadId) return sendJson(res, 400, { error: "threadId is required" });
				const threadKey = createAssistantThreadKey(channel, threadId);
				await host.resetThread(threadKey);
				return sendJson(res, 200, { ok: true });
			}

			return sendJson(res, 404, { error: "Not found" });
		} catch (error) {
			return sendJson(res, 500, { error: (error as Error).message });
		}
	});
}

export async function startWebUiServer(cwd: string, config?: WebUiServerConfig) {
	const runtime = await loadWebUiServerRuntime(cwd, config);
	const server = createWebUiServer(runtime);
	const url = new URL(runtime.hostUrl);
	const bind = runtime.config?.bind;
	const hostname = bind === "public"
		? "0.0.0.0"
		: bind === "localhost"
			? "127.0.0.1"
			: typeof bind === "string" && bind !== "tailscale"
				? bind
				: url.hostname;
		const port = Number(runtime.config?.port || url.port || 8787);
	await new Promise<void>((resolve) => {
		server.listen(port, hostname, resolve);
	});
	return { server, runtime, hostname, port };
}
