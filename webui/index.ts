import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import { startWebUiServer } from "./server.js";
import type { WebUiRouteRegistration } from "./types.js";

const routeRegistrations: WebUiRouteRegistration[] = [];

let serverState:
	| {
		activeSessions: number;
		starting?: Promise<void>;
		server?: Awaited<ReturnType<typeof startWebUiServer>>["server"];
		runtime?: Awaited<ReturnType<typeof startWebUiServer>>["runtime"];
		hostname?: string;
		port?: number;
		cwd?: string;
	}
	| undefined;

async function ensureServerStarted(ctx: ExtensionContext, pi: ExtensionAPI) {
	const config = await loadConfig(ctx.cwd);
	if (config.webui?.enabled === false) return;
	serverState ??= { activeSessions: 0 };
	if (serverState.server) return;
	if (!serverState.starting) {
		serverState.starting = (async () => {
			const started = await startWebUiServer(ctx.cwd, undefined, routeRegistrations);
			serverState = {
				...(serverState ?? { activeSessions: 0 }),
				server: started.server,
				runtime: started.runtime,
				hostname: started.hostname,
				port: started.port,
				cwd: ctx.cwd,
			};
			pi.events.emit("magpie:webui:server-ready", {
				port: started.port,
				bindAddr: started.hostname,
				hostUrl: started.runtime.hostUrl,
			});
		})();
	}
	await serverState.starting;
	serverState.starting = undefined;
}

async function maybeStopServer() {
	if (!serverState?.server || (serverState.activeSessions ?? 0) > 0) return;
	const server = serverState.server;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	serverState = undefined;
}

export default function (pi: ExtensionAPI) {
	pi.events.on("magpie:webui:register-routes", (payload: unknown) => {
		const data = payload as { routes?: WebUiRouteRegistration[] } | undefined;
		if (!Array.isArray(data?.routes)) return;
		for (const route of data.routes) {
			if (typeof route?.handler !== "function") continue;
			routeRegistrations.push(route);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		serverState ??= { activeSessions: 0 };
		serverState.activeSessions += 1;
		try {
			await ensureServerStarted(ctx, pi);
			if (ctx.hasUI && serverState?.runtime?.hostUrl) {
				ctx.ui.notify(`Web UI listening on ${serverState.runtime.hostUrl}`, "info");
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Failed to start Web UI: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (!serverState) return;
		serverState.activeSessions = Math.max(0, serverState.activeSessions - 1);
		await maybeStopServer();
	});
}
