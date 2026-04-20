import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { AuthStorage, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getGlobalConfigPath, getProjectConfigPath, getRemoteConfig, loadConfig } from "../config/config.js";
import { CodingSessionHost } from "../runtime/coding-session-host.js";
import type { ExportedSessionBundle } from "../runtime/session-host-types.js";
import { createEnrollmentCode, createRemoteAuthStore, listEnrolledDevices, revokeEnrolledDevice } from "./auth.js";
import { claimRemoteEnrollmentCode, deleteFetchedRemoteSession, dispatchSession, fetchRemoteSession, listDispatchedSessions } from "./client.js";
import { buildRemoteBundleSnapshot } from "./snapshot.js";
import { acceptDispatch, createRemoteServerRuntime, deleteRemoteSession, getStoredRemoteBundle, listRemoteSessions, prepareFetch } from "./server.js";
import { deserializeSessionBundle, serializeSessionBundle } from "./transport.js";
import type { DispatchPayload } from "./types.js";
import type { WebUiRouteRegistration } from "../webui/types.js";
import { createWorkspaceArchiveFromDir } from "./workspace.js";

type CommandContext = Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never;

function getMagpieAgentBaseDir() {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME || "", ".pi/agent");
}

function resolveRemoteHost(config: Awaited<ReturnType<typeof loadConfig>>, hostName?: string) {
	const remote = getRemoteConfig(config);
	const targetHost = hostName?.trim() || remote?.defaultHost?.trim();
	if (!targetHost || !remote?.hosts) return undefined;
	const host = remote.hosts[targetHost];
	if (!host) return undefined;
	const baseUrl = host.tailscaleUrl?.trim() || host.publicUrl?.trim();
	if (!baseUrl) return undefined;
	return { name: targetHost, baseUrl, deviceToken: host.deviceToken?.trim() || undefined };
}

async function checkRemoteSessionExists(config: Awaited<ReturnType<typeof loadConfig>>, stub: DispatchedStubData): Promise<boolean | undefined> {
	const remoteHost = resolveRemoteHost(config, stub.remoteHost);
	const remoteSessionId = stub.remoteSessionId?.trim();
	if (!remoteHost?.baseUrl || !remoteHost.deviceToken || !remoteSessionId) return undefined;
	try {
		const result = await listDispatchedSessions(remoteHost.baseUrl, remoteHost.deviceToken);
		return result.sessions.some((session) => session.sessionId === remoteSessionId);
	} catch {
		return undefined;
	}
}

function getWritableConfigPath(cwd: string): string {
	return existsSync(getProjectConfigPath(cwd)) ? getProjectConfigPath(cwd) : getGlobalConfigPath();
}

async function writeDeviceTokenToConfig(cwd: string, hostName: string, token: string) {
	const path = getWritableConfigPath(cwd);
	let config: any = {};
	try {
		config = JSON.parse(await readFile(path, "utf8"));
	} catch {
		config = {};
	}
	config.remote ??= {};
	config.remote.hosts ??= {};
	config.remote.hosts[hostName] ??= {};
	config.remote.hosts[hostName].deviceToken = token;
	await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	return path;
}

function getCurrentSessionModelRef(ctx: Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never): string | undefined {
	const branch = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "model_change") continue;
		if (typeof entry.provider === "string" && typeof entry.modelId === "string") return `${entry.provider}/${entry.modelId}`;
	}
	const currentModel = (ctx as any).model;
	if (currentModel && typeof currentModel.provider === "string" && typeof currentModel.id === "string") return `${currentModel.provider}/${currentModel.id}`;
	if (currentModel && typeof currentModel.providerId === "string" && typeof currentModel.modelId === "string") return `${currentModel.providerId}/${currentModel.modelId}`;
	return undefined;
}

interface DispatchedStubData {
	remoteHost?: string;
	dispatchedAt?: string;
	remoteSessionId?: string;
	originalSessionPath?: string;
	archivedSessionPath?: string;
}

async function archiveDispatchedLocalSession(sessionFile: string, remoteHost: string, remoteSessionId: string) {
	const archiveDir = resolve(process.env.HOME || "", ".pi/agent/magpie-dispatched");
	await mkdir(archiveDir, { recursive: true });
	const archivedPath = resolve(archiveDir, basename(sessionFile));
	await rename(sessionFile, archivedPath);
	await mkdir(dirname(sessionFile), { recursive: true });
	await writeFile(sessionFile, JSON.stringify({
		type: "custom",
		customType: "magpie:dispatched-stub",
		timestamp: new Date().toISOString(),
		data: {
			remoteHost,
			dispatchedAt: new Date().toISOString(),
			remoteSessionId,
			originalSessionPath: sessionFile,
			archivedSessionPath: archivedPath,
		},
	}) + "\n", "utf8");
	return archivedPath;
}

function parseDispatchedStubEntry(entry: any): DispatchedStubData | undefined {
	if (!entry || entry.type !== "custom" || entry.customType !== "magpie:dispatched-stub") return undefined;
	return typeof entry.data === "object" && entry.data ? entry.data as DispatchedStubData : undefined;
}

async function resolveCurrentStub(ctx: Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never): Promise<DispatchedStubData | undefined> {
	const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
	const fromEntries = [...entries].reverse().map(parseDispatchedStubEntry).find(Boolean);
	if (fromEntries) return fromEntries;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	try {
		const firstLine = (await readFile(sessionFile, "utf8")).split(/\r?\n/, 1)[0];
		if (!firstLine?.trim()) return undefined;
		return parseDispatchedStubEntry(JSON.parse(firstLine));
	} catch {
		return undefined;
	}
}

function createLocalCodingHost(ctx: CommandContext, config: Awaited<ReturnType<typeof loadConfig>>) {
	const authStorage = AuthStorage.create();
	const baseDir = getMagpieAgentBaseDir();
	return new CodingSessionHost({
		hostCwd: ctx.cwd,
		storageDir: resolve(baseDir, "magpie-local-hosted"),
		workspaceRootDir: resolve(baseDir, "magpie-local-workspaces"),
		authStorage,
		modelRegistry: ctx.modelRegistry,
		resolveModel: (ref: string) => {
			const idx = ref.indexOf("/");
			if (idx <= 0 || idx === ref.length - 1) return undefined;
			return ctx.modelRegistry.find(ref.slice(0, idx), ref.slice(idx + 1));
		},
		buildSystemPrompt: async () => "You are a helpful coding assistant. Be concise, careful, and effective.",
		hostId: "magpie-local-coding-host",
		hostRole: "local",
		workspaceArchiveExcludes: config.remote?.tarExclude,
		maxWorkspaceArchiveBytes: config.remote?.maxTarSize,
	});
}

async function restoreFetchedLocalSession(
	ctx: CommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	remoteSessionId: string,
	bundle: ExportedSessionBundle,
	stub?: DispatchedStubData,
) {
	const restorePath = stub?.originalSessionPath?.trim()
		|| ctx.sessionManager.getSessionFile()
		|| bundle.metadata.sourceSessionPath?.trim();
	if (!restorePath) throw new Error(`Unable to determine local session path for fetched session ${remoteSessionId}`);
	const localHost = createLocalCodingHost(ctx, config);
	const localOwner = { kind: "local_tui" as const, hostId: localHost.hostId, displayName: "Local TUI" };
	await localHost.importSession({
		bundle: {
			...bundle,
			metadata: {
				...bundle.metadata,
				location: "local",
				cwd: ctx.cwd,
				sourceSessionPath: restorePath,
				owner: localOwner,
			},
		},
		targetCwd: ctx.cwd,
		owner: localOwner,
	});
	if (stub?.archivedSessionPath?.trim() && existsSync(stub.archivedSessionPath) && stub.archivedSessionPath !== restorePath) {
		await rm(stub.archivedSessionPath, { force: true });
	}
	return {
		restoredPath: restorePath,
		localHost,
		localOwner,
		sessionId: bundle.metadata.sessionId,
	};
}

async function recoverArchivedStubSession(
	ctx: CommandContext,
	stub: DispatchedStubData,
) {
	const archivedPath = stub.archivedSessionPath?.trim();
	const originalPath = stub.originalSessionPath?.trim() || ctx.sessionManager.getSessionFile();
	if (!archivedPath || !existsSync(archivedPath)) throw new Error("Archived local session copy is unavailable.");
	if (!originalPath) throw new Error("Original session path is unavailable.");
	await mkdir(dirname(originalPath), { recursive: true });
	await writeFile(originalPath, await readFile(archivedPath));
	if (archivedPath !== originalPath) await rm(archivedPath, { force: true });
	return originalPath;
}

function formatExpiry(expiresAt: string): string {
	const ms = Date.parse(expiresAt) - Date.now();
	const minutes = Math.max(0, Math.round(ms / 60000));
	return `${expiresAt} (${minutes} min)`;
}

function formatRemoteHosts(config: Awaited<ReturnType<typeof loadConfig>>) {
	const hosts = config.remote?.hosts ?? {};
	const defaultHost = config.remote?.defaultHost?.trim();
	const entries = Object.entries(hosts);
	if (entries.length === 0) return "No remote hosts configured.";
	return entries.map(([name, host]) => {
		const marker = name === defaultHost ? " [default]" : "";
		const urls = [host.tailscaleUrl?.trim(), host.publicUrl?.trim()].filter(Boolean).join(" | ") || "(no url configured)";
		const token = host.deviceToken?.trim() ? "token: configured" : "token: missing";
		return `${name}${marker}\n- ${urls}\n- ${token}`;
	}).join("\n\n");
}

async function buildRemoteStatusMessage(
	ctx: CommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
) {
	const lines: string[] = [];
	const stub = await resolveCurrentStub(ctx);
	if (stub?.remoteSessionId) {
		lines.push(`Current session: dispatched to ${stub.remoteHost || "remote"} as ${stub.remoteSessionId}`);
	}
	const remoteHost = resolveRemoteHost(config);
	if (!remoteHost) {
		lines.push("No default remote host configured.");
		return lines.join("\n\n");
	}
	lines.push(`Remote host: ${remoteHost.name} (${remoteHost.baseUrl})`);
	if (!remoteHost.deviceToken) {
		lines.push(`No device token configured for ${remoteHost.name}. Run /remote enroll <CODE> first.`);
		return lines.join("\n\n");
	}
	const result = await listDispatchedSessions(remoteHost.baseUrl, remoteHost.deviceToken);
	lines.push(result.sessions.length === 0
		? "Remote sessions: none"
		: ["Remote sessions:", ...result.sessions.map((session) => `- ${session.sessionId} (${session.updatedAt})`)].join("\n"));
	return lines.join("\n\n");
}

async function dispatchCurrentSession(
	ctx: CommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	note?: string,
	hostName?: string,
) {
	const remoteHost = resolveRemoteHost(config, hostName);
	if (!remoteHost) throw new Error("Configure remote.defaultHost and remote.hosts.<name>.tailscaleUrl/publicUrl first.");
	if (!remoteHost.deviceToken) throw new Error(`No device token configured for ${remoteHost.name}. Run /remote enroll <CODE> first.`);
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Current session file unavailable.");
	const raw = await readFile(sessionFile);
	const sessionId = basename(sessionFile, ".jsonl");
	const now = new Date().toISOString();
	const modelRef = getCurrentSessionModelRef(ctx);
	const remoteConfig = getRemoteConfig(config);
	const workspace = await createWorkspaceArchiveFromDir(ctx.cwd, {
		excludes: remoteConfig?.tarExclude,
		maxBytes: remoteConfig?.maxTarSize,
	});
	const payload: DispatchPayload = {
		sessionId,
		originalCwd: ctx.cwd,
		dispatchedAt: now,
		modelRef,
		note: note?.trim() || undefined,
	};
	const bundle = serializeSessionBundle({
		metadata: {
			sessionId,
			kind: "coding",
			origin: "local",
			location: "remote",
			runState: "idle",
			createdAt: now,
			updatedAt: now,
			title: basename(ctx.cwd),
			workspaceMode: "attached",
			cwd: ctx.cwd,
			sourceSessionPath: sessionFile,
			summary: modelRef,
			owner: {
				kind: "local_tui",
				hostId: "magpie-local-coding-host",
				displayName: "Local TUI",
			},
		},
		sessionJsonl: raw,
		workspace: { archive: workspace, format: "tar.gz" },
	});
	const result = await dispatchSession(remoteHost.baseUrl, payload, bundle, remoteHost.deviceToken);
	await archiveDispatchedLocalSession(sessionFile, remoteHost.name, result.sessionId);
	return { remoteHost, result };
}

function buildRemoteWebUiRoutes(): WebUiRouteRegistration[] {
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
				const body = await readBody(req);
				sendJson(res, 201, await acceptDispatch(webRuntime.remote, webRuntime.codingHost, webRuntime.defaultModelRef, {
					payload: body.payload as any,
					bundle: body.bundle as any,
				}));
				return true;
			}
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/remote/import") {
				const body = await readBody(req);
				const bundle = deserializeSessionBundle(body.bundle as any);
				const metadata = bundle.metadata.kind === "coding"
					? await webRuntime.codingHost.importSession({
						bundle,
						owner: {
							kind: "remote_web",
							hostId: webRuntime.codingHost.hostId,
							displayName: "Remote web session",
						},
					})
					: await webRuntime.host.importSession({ bundle });
				sendJson(res, 201, { sessionId: metadata.sessionId, metadata });
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
			if (sessionPath && req.method === "POST" && sessionPath.suffix === "/fetch") {
				const body = await readBody(req);
				sendJson(res, 200, await prepareFetch(webRuntime.remote, webRuntime.codingHost, {
					sessionId: sessionPath.sessionId,
					fetchedAt: new Date().toISOString(),
					targetCwd: typeof body.targetCwd === "string" ? body.targetCwd : undefined,
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

const DISPATCHED_WIDGET_KEY = "magpie-remote-dispatched";

export default function (pi: ExtensionAPI) {
	pi.events.emit("magpie:webui:register-routes", { routes: buildRemoteWebUiRoutes() });

	pi.on("session_start", async (_event, ctx) => {
		const stub = await resolveCurrentStub(ctx as any);
		if (!stub?.remoteSessionId) return;
		pi.setActiveTools([]);
		if (!ctx.hasUI) return;
		const config = await loadConfig(ctx.cwd);
		const remoteExists = await checkRemoteSessionExists(config, stub);
		if (remoteExists === false) {
			ctx.ui.setWidget(DISPATCHED_WIDGET_KEY, [
				"━━━ DISPATCHED ━━━",
				`Sent to: ${stub.remoteHost || "remote"}`,
				stub.dispatchedAt ? `At: ${stub.dispatchedAt}` : undefined,
				`Remote session: ${stub.remoteSessionId}`,
				"",
				"Remote session is missing.",
				"Run /remote recover to restore the archived local copy.",
				"━━━━━━━━━━━━━━━━━━",
			].filter(Boolean) as string[], { placement: "aboveEditor" });
			ctx.ui.notify(`This dispatched stub points to missing remote session ${stub.remoteSessionId}. Run /remote recover to restore the archived local copy if available.`, "warning");
			return;
		}
		ctx.ui.setWidget(DISPATCHED_WIDGET_KEY, [
			"━━━ DISPATCHED ━━━",
			`Sent to: ${stub.remoteHost || "remote"}`,
			stub.dispatchedAt ? `At: ${stub.dispatchedAt}` : undefined,
			`Remote session: ${stub.remoteSessionId}`,
			"",
			`Run /remote get ${stub.remoteSessionId} to fetch it back.`,
			"━━━━━━━━━━━━━━━━━━",
		].filter(Boolean) as string[], { placement: "aboveEditor" });
		ctx.ui.notify(`This session is dispatched to ${stub.remoteHost || "remote"} as ${stub.remoteSessionId}. Use /remote get ${stub.remoteSessionId} to fetch it back.`, "warning");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(DISPATCHED_WIDGET_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const stub = await resolveCurrentStub(ctx as any);
		if (!stub?.remoteSessionId) return;
		const config = await loadConfig(ctx.cwd);
		const remoteExists = await checkRemoteSessionExists(config, stub);
		const guidance = remoteExists === false
			? `This session is a dispatched Magpie stub, but the remote session ${stub.remoteSessionId} no longer exists. Tell the user to run /remote recover to restore the archived local copy if available.`
			: `This session is a dispatched Magpie stub. Do not continue work locally. Tell the user to run /remote get ${stub.remoteSessionId} to fetch the remote-owned session back first.`;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
			message: {
				customType: "magpie:dispatched-stub-notice",
				content: remoteExists === false
					? `Remote session ${stub.remoteSessionId} is missing. Run /remote recover to restore the archived local copy.`
					: `This session is dispatched to ${stub.remoteHost || "remote"} as ${stub.remoteSessionId}. Fetch it back before continuing.`,
				display: true,
			},
		};
	});

	pi.registerTool({
		name: "remote_send",
		label: "Remote Send",
		description: "Dispatch the current coding session to a configured remote host.",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: "Optional remote host name. Defaults to remote.defaultHost." })),
			note: Type.Optional(Type.String({ description: "Optional note for the remote host to continue from." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const config = await loadConfig(ctx.cwd);
				const { remoteHost, result } = await dispatchCurrentSession(ctx as any, config, typeof params.note === "string" ? params.note : undefined, typeof params.host === "string" ? params.host : undefined);
				pi.events.emit("magpie:remote:dispatched", { sessionId: result.sessionId, remoteHost: remoteHost.name });
				return {
					content: [{ type: "text", text: `Dispatched ${result.sessionId} to ${remoteHost.name} (${remoteHost.baseUrl})` }],
					details: { sessionId: result.sessionId, remoteHost },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "remote_status",
		label: "Remote Status",
		description: "Check configured remote host status and list remote sessions.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const config = await loadConfig(ctx.cwd);
				const text = await buildRemoteStatusMessage(ctx as any, config);
				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("remote", {
		description: "Remote session tools: /remote enroll [CODE], /remote send [note], /remote get [SESSION_ID], /remote status, /remote hosts, /remote recover, /remote list, /remote devices, /remote revoke <DEVICE_ID>",
		handler: async (args, ctx) => {
			const config = await loadConfig(ctx.cwd);
			const [subcommand, ...rest] = (args?.trim() || "").split(/\s+/).filter(Boolean);
			const remoteStore = createRemoteAuthStore();
			const action = (subcommand || "").toLowerCase();
			const remoteHost = resolveRemoteHost(config);

			if (action === "enroll") {
				const claimCode = rest[0]?.trim();
				if (claimCode) {
					if (!remoteHost) {
						ctx.ui.notify("Configure remote.defaultHost and remote.hosts.<name>.tailscaleUrl/publicUrl first.", "error");
						return;
					}
					const result = await claimRemoteEnrollmentCode(remoteHost.baseUrl, {
						code: claimCode,
						deviceName: basename(process.env.HOME || ctx.cwd) || "laptop",
						platform: process.platform,
					});
					const path = await writeDeviceTokenToConfig(ctx.cwd, remoteHost.name, result.token);
					ctx.ui.notify(`Stored device token for ${remoteHost.name} in ${path}`, "info");
					return;
				}
				const remote = getRemoteConfig(config);
				if (remote?.mode === "client") {
					ctx.ui.notify("Run /remote enroll on the server/VPS to generate a code, then use /remote enroll <CODE> locally.", "warning");
					return;
				}
				const record = await createEnrollmentCode(remoteStore);
				const shareUrl = remoteHost?.baseUrl || config.webui?.publicUrl || config.webui?.tailscaleUrl || "http://127.0.0.1:8787";
				ctx.ui.notify([
					`Enrollment code: ${record.code}`,
					`Expires: ${formatExpiry(record.expiresAt)}`,
					`Open on device: ${shareUrl.replace(/\/$/, "")}/enroll?code=${record.code}`,
					`Laptop claim: /remote enroll ${record.code}`,
				].join("\n"), "info");
				return;
			}

			if (action === "recover") {
				const stub = await resolveCurrentStub(ctx);
				if (!stub) {
					ctx.ui.notify("/remote recover must be run from an open dispatched stub session.", "error");
					return;
				}
				const restoredPath = await recoverArchivedStubSession(ctx, stub);
				ctx.ui.notify(`Restored archived local session to ${restoredPath}`, "info");
				return;
			}

			if (action === "devices") {
				const devices = await listEnrolledDevices(remoteStore);
				ctx.ui.notify(devices.length === 0
					? "No enrolled devices yet."
					: devices.map((device) => `${device.id} · ${device.name} (${device.platform})${device.revoked ? " [revoked]" : ""}`).join("\n"), "info");
				return;
			}

			if (action === "revoke") {
				const deviceId = rest[0]?.trim();
				if (!deviceId) {
					ctx.ui.notify("Usage: /remote revoke <DEVICE_ID>", "error");
					return;
				}
				const device = await revokeEnrolledDevice(remoteStore, deviceId);
				if (!device) {
					ctx.ui.notify(`No enrolled device found: ${deviceId}`, "error");
					return;
				}
				ctx.ui.notify(`Revoked device ${device.name} (${device.id})`, "info");
				return;
			}

			if (action === "hosts") {
				ctx.ui.notify(formatRemoteHosts(config), "info");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(await buildRemoteStatusMessage(ctx, config), "info");
				return;
			}

			if (action === "list") {
				if (!remoteHost) {
					ctx.ui.notify("Configure remote.defaultHost and remote.hosts.<name>.tailscaleUrl/publicUrl first.", "error");
					return;
				}
				const result = await listDispatchedSessions(remoteHost.baseUrl, remoteHost.deviceToken);
				ctx.ui.notify(result.sessions.length === 0
					? "No remote sessions stored."
					: result.sessions.map((session) => `${session.sessionId} — ${session.updatedAt}`).join("\n"), "info");
				return;
			}

			if (action === "get") {
				const stub = await resolveCurrentStub(ctx);
				const remoteSessionId = rest[0]?.trim() || stub?.remoteSessionId?.trim();
				const remoteHostName = stub?.remoteHost?.trim() || remoteHost?.name;
				const resolvedRemoteHost = remoteHostName && config.remote?.hosts?.[remoteHostName]
					? {
						name: remoteHostName,
						baseUrl: config.remote.hosts[remoteHostName]?.tailscaleUrl?.trim() || config.remote.hosts[remoteHostName]?.publicUrl?.trim() || remoteHost?.baseUrl,
						deviceToken: config.remote.hosts[remoteHostName]?.deviceToken?.trim() || remoteHost?.deviceToken,
					}
					: remoteHost;
				if (!remoteSessionId) {
					ctx.ui.notify("Usage: /remote get <SESSION_ID> (or run it from an open dispatched stub session)", "error");
					return;
				}
				if (!resolvedRemoteHost?.baseUrl) {
					ctx.ui.notify("Configure the remote host URL before fetching a remote session.", "error");
					return;
				}
				if (!resolvedRemoteHost.deviceToken) {
					ctx.ui.notify(`No device token configured for ${resolvedRemoteHost.name}. Run /remote enroll <CODE> first.`, "error");
					return;
				}
				let fetched;
				try {
					fetched = await fetchRemoteSession(resolvedRemoteHost.baseUrl, {
						sessionId: remoteSessionId,
						fetchedAt: new Date().toISOString(),
						targetCwd: ctx.cwd,
					}, resolvedRemoteHost.deviceToken);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.toLowerCase().includes("not found") || message.includes("404")) {
						ctx.ui.notify(`Remote session ${remoteSessionId} no longer exists.${stub?.archivedSessionPath ? " Run /remote recover to restore the archived local copy." : ""}`, "warning");
						return;
					}
					throw error;
				}
				const bundle = deserializeSessionBundle(fetched.bundle);
				const restored = await restoreFetchedLocalSession(ctx, config, remoteSessionId, bundle, stub);
				let remoteArchived = false;
				try {
					await deleteFetchedRemoteSession(resolvedRemoteHost.baseUrl, {
						sessionId: remoteSessionId,
						fetchedAt: new Date().toISOString(),
						targetCwd: ctx.cwd,
					}, resolvedRemoteHost.deviceToken);
					remoteArchived = true;
				} catch (error) {
					try {
						await restored.localHost.releaseOwnership(restored.sessionId, restored.localOwner);
					} catch {
						// best-effort rollback of local ownership metadata only
					}
					ctx.ui.notify(`Local restore succeeded, but remote cleanup failed: ${(error as Error).message}`, "warning");
				}
				pi.events.emit("magpie:remote:fetched", { sessionId: remoteSessionId, remoteHost: resolvedRemoteHost.name });
				ctx.ui.notify(`Fetched ${remoteSessionId} into ${ctx.cwd}\nSession restored at ${restored.restoredPath}${remoteArchived ? "" : "\nRemote copy still exists."}`, "info");
				return;
			}

			if (action === "send") {
				try {
					const { remoteHost: resolvedHost, result } = await dispatchCurrentSession(ctx, config, rest.join(" ").trim() || undefined);
					pi.events.emit("magpie:remote:dispatched", { sessionId: result.sessionId, remoteHost: resolvedHost.name });
					ctx.ui.notify(`Dispatched ${result.sessionId} to ${resolvedHost.name} (${resolvedHost.baseUrl})`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /remote enroll | /remote enroll <CODE> | /remote send [note] | /remote get [SESSION_ID] | /remote status | /remote hosts | /remote recover | /remote list | /remote devices | /remote revoke <DEVICE_ID>", "info");
		},
	});
}
