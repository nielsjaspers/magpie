import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getGlobalConfigPath, getProjectConfigPath, getRemoteConfig, loadConfig } from "../config/config.js";
import { createEnrollmentCode, createRemoteAuthStore, listEnrolledDevices } from "./auth.js";
import { claimRemoteEnrollmentCode, dispatchSession, listDispatchedSessions } from "./client.js";
import { serializeSessionBundle } from "./transport.js";
import type { DispatchPayload } from "./types.js";

function resolveRemoteHost(config: Awaited<ReturnType<typeof loadConfig>>) {
	const remote = getRemoteConfig(config);
	const defaultHost = remote?.defaultHost?.trim();
	if (!defaultHost || !remote?.hosts) return undefined;
	const host = remote.hosts[defaultHost];
	if (!host) return undefined;
	const baseUrl = host.tailscaleUrl?.trim() || host.publicUrl?.trim();
	if (!baseUrl) return undefined;
	return { name: defaultHost, baseUrl, deviceToken: host.deviceToken?.trim() || undefined };
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

function formatExpiry(expiresAt: string): string {
	const ms = Date.parse(expiresAt) - Date.now();
	const minutes = Math.max(0, Math.round(ms / 60000));
	return `${expiresAt} (${minutes} min)`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("remote", {
		description: "Remote session tools: /remote enroll [CODE], /remote send [note], /remote list, /remote devices",
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
				const payload: DispatchPayload = {
					sessionId,
					originalCwd: ctx.cwd,
					dispatchedAt: now,
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
					},
					sessionJsonl: raw,
				});
				const result = await dispatchSession(remoteHost.baseUrl, payload, bundle, remoteHost.deviceToken);
				ctx.ui.notify(`Dispatched ${result.sessionId} to ${remoteHost.name} (${remoteHost.baseUrl})`, "info");
				return;
			}

			ctx.ui.notify("Usage: /remote enroll | /remote enroll <CODE> | /remote send [note] | /remote list | /remote devices", "info");
		},
	});
}
