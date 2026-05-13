import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { expandHomePath, getPersonalAssistantStorageDir, getTelegramConfig, getWebUiConfig, loadConfig } from "../config/config.js";
import { AssistantSessionHost, parseAssistantThreadKey } from "../runtime/assistant-session-host.js";
import { CodingSessionHost } from "../runtime/coding-session-host.js";
import { createRemoteServerRuntime } from "../remote/server.js";
import type { DeviceRecord } from "../remote/types.js";
import { createRemoteAuthStore } from "../remote/auth.js";
import {
	getSessionIdFromRequestPath,
	readBody,
	sendJson,
} from "./request.js";
import {
	handleAssistantLegacyRoute,
	ownerForAssistantChannel,
} from "./routes/assistant-legacy.js";
import {
	authenticateWebUiRequest,
	handleEnrollmentRoute,
} from "./routes/auth.js";
import {
	createSessionRoute,
	getSessionSnapshotRoute,
	getSessionStatusRoute,
	listSessionRoute,
	parseCreateSessionInput,
	parseSessionFilter,
} from "./routes/session.js";
import { handleSessionMemberRoute } from "./routes/session-api.js";
import { createStaticAssetRoutes, serveStaticAsset } from "./routes/assets.js";
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
		const readScoped = async (filePath: string | undefined) => {
			if (!filePath?.trim()) return undefined;
			const expanded = expandHomePath(filePath.trim());
			if (expanded.startsWith("/")) {
				return await tryReadText(expanded);
			}
			return (await tryReadText(resolve(projectBaseDir, expanded))) ??
				(await tryReadText(resolve(globalBaseDir, expanded)));
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
		tools: config?.availableTools,
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

export function createWebUiServer(runtime: WebUiServerRuntime, routeRegistrations: WebUiRouteRegistration[] = []): Server {
	const { host, codingHost, remote, auth, defaultModelRef, hostUrl } = runtime;
	const clientDir = resolve(import.meta.dirname, "client");
	const staticAssetRoutes = createStaticAssetRoutes(clientDir);
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

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url || "/", hostUrl);
			const authResult = await authenticateWebUiRequest({ auth, req, res, requestUrl, enrollmentLimiter, deviceRequestLimiter });
			if (authResult.handled) return;
			const authenticatedDevice = authResult.device;
			if (req.method === "GET" && requestUrl.pathname === "/health") {
				return sendJson(res, 200, { ok: true, hostId: host.hostId, hostRole: host.hostRole });
			}
			if (req.method === "GET") {
				const staticRoute = staticAssetRoutes.find((route) => route.pathname === requestUrl.pathname);
				if (staticRoute) {
					await serveStaticAsset(res, staticRoute);
					return;
				}
			}
			if (await handleEnrollmentRoute({ auth, req, res, requestUrl })) return;
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/models") {
				const models = modelRegistry.getAll();
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
				return sendJson(res, 201, { sessionId: session.metadata.sessionId, metadata: session.metadata, created: true });
			}

			if (await handleSessionMemberRoute({
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
				resetAssistantSession: async (sessionId) => await host.resetSession(sessionId),
				getCodingSession: async (sessionId) => await codingHost.getSession(sessionId),
				getAssistantSession: async (sessionId) => await host.getSession(sessionId),
			})) return;

			if (await handleAssistantLegacyRoute({ host, defaultModelRef, req, res, requestUrl })) return;

			if (req.method !== "POST" || !req.url) {
				return sendJson(res, 404, { error: "Not found" });
			}

			return sendJson(res, 404, { error: "Not found" });
		} catch (error) {
			if (res.headersSent) {
				if (!res.writableEnded) res.end();
				return;
			}
			if ((error as { statusCode?: number }).statusCode === 413) {
				return sendJson(res, 413, { error: (error as Error).message });
			}
			return sendJson(res, 500, { error: (error as Error).message });
		}
	});
	server.requestTimeout = 60_000;
	server.headersTimeout = 65_000;
	server.timeout = 120_000;
	server.keepAliveTimeout = 5_000;
	return server;
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
