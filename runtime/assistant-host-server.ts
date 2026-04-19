import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getPersonalAssistantStorageDir, getTelegramConfig, loadConfig } from "../config/config.js";
import {
	AssistantSessionHost,
	createAssistantThreadKey,
	parseAssistantThreadKey,
} from "./assistant-session-host.js";
import type { AssistantChannel, SessionFilter } from "./session-host-types.js";

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

async function loadServerContext(cwd: string) {
	const config = await loadConfig(cwd);
	const telegram = getTelegramConfig(config);
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
		storageDir: resolve(getPersonalAssistantStorageDir(config), "telegram"),
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
		defaultModelRef,
		hostUrl: telegram?.hostUrl?.trim() || "http://127.0.0.1:8787",
	};
}

function readBody(req: import("node:http").IncomingMessage): Promise<any> {
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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function normalizeAssistantChannel(value: string | null | undefined): AssistantChannel | undefined {
	if (value === "telegram" || value === "web" || value === "internal") return value;
	return undefined;
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

const cwd = process.cwd();
const { host, defaultModelRef, hostUrl } = await loadServerContext(cwd);
const url = new URL(hostUrl);
const hostname = url.hostname;
const port = Number(url.port || 8787);

const server = createServer(async (req, res) => {
	try {
		const requestUrl = new URL(req.url || "/", hostUrl);
		if (req.method === "GET" && requestUrl.pathname === "/health") {
			return sendJson(res, 200, { ok: true, hostId: host.hostId, hostRole: host.hostRole });
		}

		if (req.method === "GET" && requestUrl.pathname === "/api/v1/sessions") {
			const filter: SessionFilter = {
				kind: requestUrl.searchParams.get("kind") === "assistant" || requestUrl.searchParams.get("kind") === "coding"
					? requestUrl.searchParams.get("kind") as SessionFilter["kind"]
					: undefined,
				location: requestUrl.searchParams.get("location") as SessionFilter["location"] ?? undefined,
				runState: requestUrl.searchParams.get("runState") as SessionFilter["runState"] ?? undefined,
				assistantChannel: normalizeAssistantChannel(requestUrl.searchParams.get("assistantChannel")),
				query: requestUrl.searchParams.get("query") || undefined,
				includeArchived: requestUrl.searchParams.get("includeArchived") === "1",
				limit: requestUrl.searchParams.get("limit") ? Number(requestUrl.searchParams.get("limit")) : undefined,
			};
			const sessions = await host.listSessions(filter);
			return sendJson(res, 200, { sessions });
		}

		const sessionPath = getSessionIdFromRequestPath(requestUrl.pathname);
		if (sessionPath && req.method === "GET" && sessionPath.suffix === "") {
			const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
			const status = await host.getStatus(sessionPath.sessionId, modelRef);
			if (!status) return sendJson(res, 404, { error: "Session not found" });
			return sendJson(res, 200, status);
		}
		if (sessionPath && req.method === "GET" && sessionPath.suffix === "/snapshot") {
			const modelRef = requestUrl.searchParams.get("modelRef") || defaultModelRef;
			const limit = Number(requestUrl.searchParams.get("limit") || 20);
			const snapshot = await host.getSnapshot(sessionPath.sessionId, modelRef, limit);
			if (!snapshot) return sendJson(res, 404, { error: "Session not found" });
			return sendJson(res, 200, snapshot);
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

server.listen(port, hostname, () => {
	console.log(`Assistant host listening on ${hostUrl}`);
});
