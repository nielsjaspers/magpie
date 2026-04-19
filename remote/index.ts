import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRemoteConfig, getWebUiConfig, loadConfig } from "../config/config.js";
import { createEnrollmentCode, createRemoteAuthStore, listEnrolledDevices } from "./auth.js";
import { dispatchSession, listDispatchedSessions } from "./client.js";
import { serializeSessionBundle } from "./transport.js";
import type { DispatchPayload } from "./types.js";

function resolveRemoteShareUrl(config: Awaited<ReturnType<typeof loadConfig>>): string | undefined {
	const remote = getRemoteConfig(config);
	const webui = getWebUiConfig(config);
	const defaultHost = remote?.defaultHost?.trim();
	if (defaultHost && remote?.hosts?.[defaultHost]) {
		const host = remote.hosts[defaultHost];
		return host.tailscaleUrl?.trim() || host.publicUrl?.trim();
	}
	return webui?.publicUrl?.trim() || webui?.tailscaleUrl?.trim() || config.telegram?.hostUrl?.trim();
}

function resolveRemoteLocalUrl(config: Awaited<ReturnType<typeof loadConfig>>): string | undefined {
	const webui = getWebUiConfig(config);
	const configuredPort = webui?.port;
	if (configuredPort) return `http://127.0.0.1:${configuredPort}`;
	if (config.telegram?.hostUrl) {
		const url = new URL(config.telegram.hostUrl);
		return `http://127.0.0.1:${url.port || "8787"}`;
	}
	return "http://127.0.0.1:8787";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("remote", {
		description: "Remote session tools: /remote enroll, /remote send [note], /remote list, /remote devices",
		handler: async (args, ctx) => {
			const config = await loadConfig(ctx.cwd);
			const [subcommand, ...rest] = (args?.trim() || "").split(/\s+/).filter(Boolean);
			const remoteStore = createRemoteAuthStore();
			const action = (subcommand || "").toLowerCase();

			if (action === "enroll") {
				const record = await createEnrollmentCode(remoteStore);
				const shareUrl = resolveRemoteShareUrl(config) || "http://127.0.0.1:8787";
				ctx.ui.notify([
					`Enrollment code: ${record.code}`,
					`Expires: ${record.expiresAt}`,
					`Open on device: ${shareUrl.replace(/\/$/, "")}/enroll?code=${record.code}`,
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
				const baseUrl = resolveRemoteLocalUrl(config);
				if (!baseUrl) {
					ctx.ui.notify("No local webui host URL configured.", "error");
					return;
				}
				const result = await listDispatchedSessions(baseUrl);
				ctx.ui.notify(result.sessions.length === 0
					? "No remote sessions stored."
					: result.sessions.map((session) => `${session.sessionId} — ${session.updatedAt}`).join("\n"), "info");
				return;
			}

			if (action === "send") {
				const baseUrl = resolveRemoteLocalUrl(config);
				if (!baseUrl) {
					ctx.ui.notify("No local webui host URL configured.", "error");
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
				const result = await dispatchSession(baseUrl, payload, bundle);
				ctx.ui.notify(`Dispatched ${result.sessionId} to ${baseUrl}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /remote enroll | /remote send [note] | /remote list | /remote devices", "info");
		},
	});
}
