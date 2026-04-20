import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getGlobalConfigPath, getProjectConfigPath, getRemoteConfig, loadConfig } from "../config/config.js";
import { createEnrollmentCode, createRemoteAuthStore, listEnrolledDevices } from "./auth.js";
import { claimRemoteEnrollmentCode, deleteFetchedRemoteSession, dispatchSession, fetchRemoteSession, listDispatchedSessions } from "./client.js";
import { deserializeSessionBundle, serializeSessionBundle } from "./transport.js";
import type { DispatchPayload } from "./types.js";
import { createWorkspaceArchiveFromDir, ensureCleanDirectory, extractWorkspaceArchiveToDir } from "./workspace.js";

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

async function restoreFetchedLocalSession(
	ctx: Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never,
	remoteSessionId: string,
	bundle: { metadata: { sourceSessionPath?: string }; sessionJsonl: Uint8Array; workspace?: { archive: Uint8Array } },
	stub?: DispatchedStubData,
) {
	await ensureCleanDirectory(ctx.cwd);
	if (bundle.workspace?.archive) await extractWorkspaceArchiveToDir(bundle.workspace.archive, ctx.cwd);
	const restorePath = stub?.originalSessionPath?.trim()
		|| ctx.sessionManager.getSessionFile()
		|| bundle.metadata.sourceSessionPath?.trim();
	if (!restorePath) throw new Error(`Unable to determine local session path for fetched session ${remoteSessionId}`);
	await mkdir(dirname(restorePath), { recursive: true });
	await writeFile(restorePath, Buffer.from(bundle.sessionJsonl), "utf8");
	if (stub?.archivedSessionPath?.trim() && existsSync(stub.archivedSessionPath) && stub.archivedSessionPath !== restorePath) {
		await rm(stub.archivedSessionPath, { force: true });
	}
	return restorePath;
}

async function recoverArchivedStubSession(
	ctx: Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never,
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const stub = await resolveCurrentStub(ctx as any);
		if (!stub?.remoteSessionId) return;
		pi.setActiveTools([]);
		if (!ctx.hasUI) return;
		const config = await loadConfig(ctx.cwd);
		const remoteExists = await checkRemoteSessionExists(config, stub);
		if (remoteExists === false) {
			ctx.ui.notify(`This dispatched stub points to missing remote session ${stub.remoteSessionId}. Run /remote recover to restore the archived local copy if available.`, "warning");
			return;
		}
		ctx.ui.notify(`This session is dispatched to ${stub.remoteHost || "remote"} as ${stub.remoteSessionId}. Use /remote get ${stub.remoteSessionId} to fetch it back.`, "warning");
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

	pi.registerCommand("remote", {
		description: "Remote session tools: /remote enroll [CODE], /remote send [note], /remote get [SESSION_ID], /remote recover, /remote list, /remote devices",
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
					: devices.map((device) => `${device.name} (${device.platform})${device.revoked ? " [revoked]" : ""}`).join("\n"), "info");
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
				const restoredPath = await restoreFetchedLocalSession(ctx, remoteSessionId, bundle, stub);
				let remoteArchived = false;
				try {
					await deleteFetchedRemoteSession(resolvedRemoteHost.baseUrl, {
						sessionId: remoteSessionId,
						fetchedAt: new Date().toISOString(),
						targetCwd: ctx.cwd,
					}, resolvedRemoteHost.deviceToken);
					remoteArchived = true;
				} catch (error) {
					ctx.ui.notify(`Local restore succeeded, but remote cleanup failed: ${(error as Error).message}`, "warning");
				}
				ctx.ui.notify(`Fetched ${remoteSessionId} into ${ctx.cwd}\nSession restored at ${restoredPath}${remoteArchived ? "" : "\nRemote copy still exists."}`, "info");
				return;
			}

			if (action === "send") {
				if (!remoteHost) {
					ctx.ui.notify("Configure remote.defaultHost and remote.hosts.<name>.tailscaleUrl/publicUrl first.", "error");
					return;
				}
				if (!remoteHost.deviceToken) {
					ctx.ui.notify(`No device token configured for ${remoteHost.name}. Run /remote enroll <CODE> first.`, "error");
					return;
				}
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("Current session file unavailable.", "error");
					return;
				}
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
					note: rest.join(" ").trim() || undefined,
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
					},
					sessionJsonl: raw,
					workspace: { archive: workspace, format: "tar.gz" },
				});
				const result = await dispatchSession(remoteHost.baseUrl, payload, bundle, remoteHost.deviceToken);
				await archiveDispatchedLocalSession(sessionFile, remoteHost.name, result.sessionId);
				ctx.ui.notify(`Dispatched ${result.sessionId} to ${remoteHost.name} (${remoteHost.baseUrl})`, "info");
				return;
			}

			ctx.ui.notify("Usage: /remote enroll | /remote enroll <CODE> | /remote send [note] | /remote get [SESSION_ID] | /remote recover | /remote list | /remote devices", "info");
		},
	});
}
