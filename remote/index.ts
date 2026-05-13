import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getRemoteConfig, loadConfig } from "../config/config.js";
import { createEnrollmentCode, createRemoteAuthStore, listEnrolledDevices, revokeEnrolledDevice } from "./auth.js";
import { claimRemoteEnrollmentCode, deleteFetchedRemoteSession, fetchRemoteSession, listDispatchedSessions } from "./client.js";
import { resolveRemoteHost, resolveRemoteHostByName, writeDeviceTokenToConfig } from "./config.js";
import { checkRemoteSessionExists, dispatchCurrentSession, restoreFetchedLocalSession } from "./dispatch.js";
import { formatExpiry, formatRemoteHosts } from "./format.js";
import type { CommandContext } from "./host.js";
import { buildRemoteWebUiRoutes } from "./routes.js";
import { recoverArchivedStubSession, resolveCurrentStub } from "./stub.js";
import { deserializeSessionBundle } from "./transport.js";
export { buildRemoteWebUiRoutes } from "./routes.js";

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
				const resolvedRemoteHost = remoteHostName ? resolveRemoteHostByName(config, remoteHostName, remoteHost) : remoteHost;
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
				ctx.ui.notify(`Fetched ${remoteSessionId}\nSession restored at ${restored.restoredPath}${restored.workspacePath ? `\nWorkspace restored at ${restored.workspacePath}` : ""}${remoteArchived ? "" : "\nRemote copy still exists."}`, "info");
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
