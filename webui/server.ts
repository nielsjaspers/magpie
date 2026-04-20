import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getPersonalAssistantStorageDir, getTelegramConfig, getWebUiConfig, loadConfig } from "../config/config.js";
import { AssistantSessionHost, createAssistantThreadKey, parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import { CodingSessionHost } from "../runtime/coding-session-host.js";
import { createRemoteServerRuntime } from "../remote/server.js";
import type { DeviceRecord } from "../remote/types.js";
import {
	authenticateRequest,
	consumeEnrollmentCode,
	createEnrollmentCode,
	createRemoteAuthStore,
	isLoopbackRequest,
} from "../remote/auth.js";
import { serializeSessionBundle } from "../remote/transport.js";
import {
	createSessionRoute,
	getSessionSnapshotRoute,
	getSessionStatusRoute,
	listSessionRoute,
	normalizeAssistantChannel,
	parseCreateSessionInput,
	parseSessionFilter,
} from "./routes/session.js";
import type { WebUiRouteRegistration, WebUiServerConfig } from "./types.js";

export interface WebUiServerRuntime {
	host: AssistantSessionHost;
	codingHost: CodingSessionHost;
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

function ownerForAssistantChannel(hostId: string, channel?: "telegram" | "web" | "internal") {
	if (channel === "web") {
		return { kind: "remote_web" as const, hostId, displayName: "Remote web assistant session" };
	}
	if (channel === "telegram") {
		return { kind: "system" as const, hostId, displayName: "Telegram assistant session" };
	}
	return { kind: "system" as const, hostId, displayName: "Assistant session" };
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
		agentDir: globalBaseDir,
	});

	const codingHost = new CodingSessionHost({
		hostCwd: cwd,
		storageDir: resolve(process.env.HOME || "", ".pi/agent/magpie-remote-hosted"),
		workspaceRootDir: resolve(process.env.HOME || "", ".pi/agent/magpie-workspaces"),
		authStorage,
		modelRegistry,
		resolveModel,
		buildSystemPrompt: async () => "You are a helpful coding assistant. Be concise, careful, and effective.",
		hostId: "magpie-remote-coding-host",
		hostRole: "remote",
		workspaceArchiveExcludes: loadedConfig.remote?.tarExclude,
		maxWorkspaceArchiveBytes: loadedConfig.remote?.maxTarSize,
		agentDir: globalBaseDir,
	});

	return {
		host,
		codingHost,
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

function parseMultipartFormData(req: IncomingMessage): Promise<Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>> {
	return new Promise((resolve, reject) => {
		const contentType = req.headers["content-type"] || "";
		const match = contentType.match(/boundary=([^;]+)/i);
		if (!match) return reject(new Error("Missing multipart boundary"));
		let boundary = match[1].trim();
		if (boundary.startsWith('"') && boundary.endsWith('"')) boundary = boundary.slice(1, -1);

		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks);
				const boundaryBuf = Buffer.from(`--${boundary}`);
				const parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }> = [];

				let idx = 0;
				while (true) {
					idx = body.indexOf(boundaryBuf, idx);
					if (idx === -1) break;
					idx += boundaryBuf.length;

					if (body.slice(idx, idx + 2).toString() === "--") break;

					if (body.slice(idx, idx + 2).toString() === "\r\n") idx += 2;
					else if (body[idx] === 0x0a) idx += 1;

					const nextBoundary = body.indexOf(boundaryBuf, idx);
					if (nextBoundary === -1) break;

					let partEnd = nextBoundary;
					if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;
					else if (body[partEnd - 1] === 0x0a) partEnd -= 1;

					const part = body.slice(idx, partEnd);
					const headerEnd = part.indexOf("\r\n\r\n");
					if (headerEnd === -1) continue;

					const headerStr = part.slice(0, headerEnd).toString("utf8");
					const data = part.slice(headerEnd + 4);

					const nameMatch = headerStr.match(/name="([^"]+)"/);
					const filenameMatch = headerStr.match(/filename="([^"]*)"/);
					const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

					if (nameMatch) {
						parts.push({
							name: nameMatch[1],
							filename: filenameMatch ? filenameMatch[1] : undefined,
							contentType: ctMatch ? ctMatch[1].trim() : undefined,
							data,
						});
					}
					idx = nextBoundary;
				}
				resolve(parts);
			} catch (err) {
				reject(err);
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

function recordRateLimit(map: Map<string, number[]>, key: string, maxEvents: number, windowMs: number): boolean {
	const now = Date.now();
	const cutoff = now - windowMs;
	const events = (map.get(key) ?? []).filter((value) => value > cutoff);
	events.push(now);
	map.set(key, events);
	return events.length <= maxEvents;
}

function getRequestIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
	return req.socket.remoteAddress || "unknown";
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

export function createWebUiServer(runtime: WebUiServerRuntime, routeRegistrations: WebUiRouteRegistration[] = []): Server {
	const { host, codingHost, remote, auth, defaultModelRef, hostUrl } = runtime;
	const clientDir = resolve(import.meta.dirname, "client");
	const deviceRequestLimiter = new Map<string, number[]>();
	const enrollmentLimiter = new Map<string, number[]>();

	const listAllSessions = async () => {
		const [assistantSessions, codingSessions] = await Promise.all([
			host.listSessions(),
			codingHost.listSessions(),
		]);
		return [...codingSessions, ...assistantSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	};

	const getSessionAny = async (sessionId: string, modelRef?: string) => {
		return await host.getSession(sessionId, modelRef) ?? await codingHost.getSession(sessionId, modelRef);
	};

	const getSessionStatusAny = async (sessionId: string, modelRef?: string) => {
		const session = await getSessionAny(sessionId, modelRef);
		return session ? await session.getStatus(modelRef) : undefined;
	};

	const getSessionSnapshotAny = async (sessionId: string, modelRef?: string, limit = 20) => {
		const session = await getSessionAny(sessionId, modelRef);
		return session ? await session.getSnapshot(modelRef, limit) : undefined;
	};

	const subscribeAny = async (sessionId: string, listener: any, watcher: { assistant?: any; coding?: any }, modelRef?: string) => {
		if (await host.getStatus(sessionId, modelRef)) return await host.subscribe(sessionId, listener, watcher.assistant, modelRef);
		return await codingHost.subscribe(sessionId, listener, watcher.coding, modelRef);
	};

	const interruptAny = async (sessionId: string, modelRef?: string) => {
		const webActor = { kind: "remote_web" as const, hostId: host.hostId, displayName: "Remote web session" };
		if (await host.getStatus(sessionId, modelRef)) return await host.interrupt(sessionId, webActor, modelRef);
		return await codingHost.interrupt(sessionId, webActor, modelRef);
	};

	const promptAny = async (sessionId: string, text: string, modelRef: string) => {
		const parsedAssistantThread = parseAssistantThreadKey(sessionId);
		const assistantStatus = parsedAssistantThread ? undefined : await host.getStatus(sessionId, modelRef);
		if (parsedAssistantThread || assistantStatus) {
			if (parsedAssistantThread) {
				await host.resolveAssistantSession({
					kind: "assistant",
					origin: "assistant",
					assistantChannel: parsedAssistantThread.channel,
					assistantThreadId: parsedAssistantThread.threadId,
					workspaceMode: "none",
					modelRef,
					owner: ownerForAssistantChannel(host.hostId, parsedAssistantThread.channel),
				});
			}
			await host.claimOwnership(sessionId, ownerForAssistantChannel(host.hostId, parsedAssistantThread?.channel ?? assistantStatus?.assistantChannel));
			const toolEvents: Array<{ type: "start" | "end"; toolName: string; args?: unknown; result?: string; isError?: boolean }> = [];
			const { accepted, result } = await host.promptSession(sessionId, { text, modelRef }, (event) => {
				if (event.type === "start") toolEvents.push({ type: "start", toolName: event.toolName, args: event.args });
				else toolEvents.push({ type: "end", toolName: event.toolName, result: event.result, isError: event.isError });
			});
			return { accepted, text: result.text || "", toolEvents };
		}
		const accepted = await codingHost.sendUserMessage(sessionId, {
			text,
			modelRef,
			source: "web",
			actor: { kind: "remote_web", hostId: codingHost.hostId, displayName: "Remote web session" },
		});
		const snapshot = await codingHost.getSnapshot(sessionId, modelRef, 8);
		const last = snapshot?.messages.at(-1);
		return { accepted, text: last?.role === "assistant" ? last.text || "" : "", toolEvents: [] };
	};

	const buildWatchersForRequest = (sessionId: string, device?: DeviceRecord) => {
		const kind = device ? "web" : "local_status";
		return {
			assistant: {
				id: `${kind}:${device?.id ?? "loopback"}:${sessionId}`,
				kind,
				hostId: host.hostId,
				actorId: device?.id,
			},
			coding: {
				id: `${kind}:${device?.id ?? "loopback"}:${sessionId}`,
				kind,
				hostId: codingHost.hostId,
				actorId: device?.id,
			},
		};
	};

	return createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url || "/", hostUrl);
			let authenticatedDevice: DeviceRecord | undefined;
			const isPublicPath = requestUrl.pathname === "/health"
				|| requestUrl.pathname === "/enroll"
				|| requestUrl.pathname === "/api/v1/enroll"
				|| requestUrl.pathname === "/api/v1/enroll/code"
				|| requestUrl.pathname === "/api/v1/enroll/claim";
			if ((requestUrl.pathname === "/api/v1/enroll" || requestUrl.pathname === "/api/v1/enroll/claim" || requestUrl.pathname === "/api/v1/enroll/code") && req.method === "POST") {
				const ip = getRequestIp(req);
				if (!recordRateLimit(enrollmentLimiter, ip, 10, 60 * 60 * 1000)) {
					return sendJson(res, 429, { error: "Too many enrollment attempts. Try again later." });
				}
			}
			if (!isPublicPath && !isLoopbackRequest(req)) {
				authenticatedDevice = await authenticateRequest(auth, req);
				if (!authenticatedDevice) {
					if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/assets/")) {
						res.statusCode = 302;
						res.setHeader("location", "/enroll");
						res.end();
						return;
					}
					return sendJson(res, 401, { error: "Unauthorized" });
				}
				if (!recordRateLimit(deviceRequestLimiter, authenticatedDevice.id, 100, 60 * 1000)) {
					return sendJson(res, 429, { error: "Rate limit exceeded. Try again later." });
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
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll/code") {
				const result = await createEnrollmentCode(auth);
				return sendJson(res, 201, { code: result.code, expiresAt: result.expiresAt });
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
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll/claim") {
				const body = await readBody(req);
				const result = await consumeEnrollmentCode(auth, {
					code: String(body.code || ""),
					deviceName: String(body.deviceName || "device"),
					platform: String(body.platform || req.headers["user-agent"] || "cli"),
				});
				return sendJson(res, 200, { ok: true, token: result.token, device: result.device });
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
			if (req.method === "GET" && requestUrl.pathname === "/assets/css/style.css") {
				res.statusCode = 200;
				res.setHeader("content-type", "text/css; charset=utf-8");
				res.end(await readFile(resolve(clientDir, "css/style.css"), "utf8"));
				return;
			}

			if (req.method === "GET" && requestUrl.pathname === "/api/v1/models") {
				const models = modelRegistry.models; // 'models' getter instead of 'list()' function
				return sendJson(res, 200, { models, defaultModel: defaultModelRef });
			}
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/sessions") {
				const filter = parseSessionFilter(requestUrl.searchParams);
				const sessions = (await listAllSessions()).filter((session) => {
					if (filter.kind && session.kind !== filter.kind) return false;
					if (filter.location && session.location !== filter.location) return false;
					if (filter.runState && session.runState !== filter.runState) return false;
					if (filter.ownerKind && session.owner?.kind !== filter.ownerKind) return false;
					if (filter.assistantChannel && session.assistantChannel !== filter.assistantChannel) return false;
					if (!filter.includeArchived && session.location === "archived") return false;
					if (!filter.query?.trim()) return true;
					const query = filter.query.trim().toLowerCase();
					return [session.sessionId, session.title, session.cwd, session.assistantThreadId].some((value) => value?.toLowerCase().includes(query));
				});
				return sendJson(res, 200, { sessions: filter.limit ? sessions.slice(0, filter.limit) : sessions });
			}
			for (const registration of routeRegistrations) {
				const handled = await registration.handler({
					req,
					res,
					requestUrl,
					runtime,
					readBody,
					sendJson,
					getSessionIdFromRequestPath,
				});
				if (handled) return;
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/sessions") {
				const body = await readBody(req);
				const input = parseCreateSessionInput(body, defaultModelRef);
				if (input.kind === "assistant") return sendJson(res, 201, await createSessionRoute(host, input));
				const session = await codingHost.createSession({
					...input,
					workspaceMode: "attached",
					origin: input.origin === "assistant" ? "remote" : input.origin,
					owner: { kind: "remote_web", hostId: codingHost.hostId, displayName: "Remote web session" },
				});
				return sendJson(res, 201, { sessionId: session.metadata.sessionId, metadata: session.metadata });
			}

			const sessionPath = getSessionIdFromRequestPath(requestUrl.pathname);
			if (sessionPath && req.method === "GET" && sessionPath.suffix === "/stream") {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const status = await getSessionStatusAny(sessionPath.sessionId, modelRef);
				if (!status) return sendJson(res, 404, { error: "Session not found" });
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
				return;
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/export") {
				const body = await readBody(req);
				const modelRef = typeof body.modelRef === "string" && body.modelRef.trim() ? body.modelRef : defaultModelRef;
				try {
					const session = await getSessionAny(sessionPath.sessionId, modelRef);
					if (!session) return sendJson(res, 404, { error: "Session not found" });
					const bundle = await session.export(modelRef);
					return sendJson(res, 200, serializeSessionBundle(bundle));
				} catch {
					return sendJson(res, 404, { error: "Session not found" });
				}
			}
			if (sessionPath && req.method === "GET" && (sessionPath.suffix === "" || sessionPath.suffix === "/status")) {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const status = await getSessionStatusAny(sessionPath.sessionId, modelRef);
				if (!status) return sendJson(res, 404, { error: "Session not found" });
				return sendJson(res, 200, status);
			}
			if (sessionPath && req.method === "GET" && sessionPath.suffix === "/snapshot") {
				const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
				const limit = Number(requestUrl.searchParams.get("limit") || 20);
				const snapshot = await getSessionSnapshotAny(sessionPath.sessionId, modelRef, limit);
				if (!snapshot) return sendJson(res, 404, { error: "Session not found" });
				return sendJson(res, 200, snapshot);
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/files") {
				try {
					const parts = await parseMultipartFormData(req);
					const fileParts = parts.filter((p) => p.filename);
					if (fileParts.length === 0) return sendJson(res, 400, { error: "No files uploaded" });

					const codingSession = await codingHost.getSession(sessionPath.sessionId);
					if (!codingSession) {
						const assistantSession = await host.getSession(sessionPath.sessionId);
						if (assistantSession) return sendJson(res, 400, { error: "File uploads are only supported for coding sessions" });
						return sendJson(res, 404, { error: "Session not found" });
					}

					const workspaceDir = codingSession.metadata.cwd;
					const results: string[] = [];

					for (const part of fileParts) {
						const targetPath = resolve(workspaceDir, part.filename!);
						if (!targetPath.startsWith(workspaceDir)) {
							return sendJson(res, 400, { error: "Invalid filename" });
						}
						await writeFile(targetPath, part.data);
						results.push(part.filename!);
					}

					return sendJson(res, 200, { ok: true, files: results });
				} catch (err) {
					return sendJson(res, 500, { error: (err as Error).message });
				}
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/message") {
				const body = await readBody(req);
				const text = String(body.text || "");
				const modelRef = String(body.modelRef || defaultModelRef);
				if (!text) return sendJson(res, 400, { error: "text is required" });
				const result = await promptAny(sessionPath.sessionId, text, modelRef);
				return sendJson(res, 200, {
					text: result.text,
					sessionId: sessionPath.sessionId,
					accepted: result.accepted,
					toolEvents: result.toolEvents,
				});
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/interrupt") {
				const body = await readBody(req);
				const modelRef = String(body.modelRef || defaultModelRef);
				await interruptAny(sessionPath.sessionId, modelRef);
				return sendJson(res, 200, { ok: true });
			}
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/reset") {
				await host.resetSession(sessionPath.sessionId);
				return sendJson(res, 200, { ok: true });
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
					owner: ownerForAssistantChannel(host.hostId, channel),
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
				await host.resolveAssistantSession({
					kind: "assistant",
					origin: "assistant",
					assistantChannel: channel,
					assistantThreadId: threadId,
					workspaceMode: "none",
					modelRef,
					owner: ownerForAssistantChannel(host.hostId, channel),
				});
				await host.claimOwnership(threadKey, ownerForAssistantChannel(host.hostId, channel));
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
			if (res.headersSent) {
				if (!res.writableEnded) res.end();
				return;
			}
			return sendJson(res, 500, { error: (error as Error).message });
		}
	});
}

export async function startWebUiServer(cwd: string, config?: WebUiServerConfig, routeRegistrations: WebUiRouteRegistration[] = []) {
	const runtime = await loadWebUiServerRuntime(cwd, config);
	const server = createWebUiServer(runtime, routeRegistrations);
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
