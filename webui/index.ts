import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
		stopping?: Promise<void>;
		hostname?: string;
		port?: number;
		cwd?: string;
	}
	| undefined;

async function ensureServerStarted(ctx: ExtensionContext, pi: ExtensionAPI) {
	const config = await loadConfig(ctx.cwd);
	if (config.webui?.enabled === false) return;
	const state = serverState ??= { activeSessions: 0 };
	if (state.cwd && state.cwd !== ctx.cwd) {
		throw new Error(`Web UI server is already running for ${state.cwd}; cannot attach session for ${ctx.cwd}`);
	}
	state.cwd ??= ctx.cwd;
	if (state.stopping) {
		await state.stopping;
		return ensureServerStarted(ctx, pi);
	}
	if (state.server) return;
	if (!state.starting) {
		state.starting = (async () => {
			const started = await startWebUiServer(ctx.cwd, {
				availableTools: pi.getAllTools(),
			}, routeRegistrations);
			state.server = started.server;
			state.runtime = started.runtime;
			state.hostname = started.hostname;
			state.port = started.port;
			state.cwd = ctx.cwd;
			pi.events.emit("magpie:webui:server-ready", {
				port: started.port,
				bindAddr: started.hostname,
				hostUrl: started.runtime.hostUrl,
			});
		})();
	}
	try {
		await state.starting;
	} finally {
		if (serverState === state) state.starting = undefined;
	}
}

async function maybeStopServer() {
	const state = serverState;
	if (!state?.server || (state.activeSessions ?? 0) > 0) return;
	if (state.stopping) return state.stopping;
	const server = state.server;
	state.stopping = new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
	try {
		await state.stopping;
	} finally {
		if (serverState === state) serverState = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.events.on("magpie:webui:register-routes", (payload: unknown) => {
		const data = payload as { routes?: WebUiRouteRegistration[] } | undefined;
		if (!Array.isArray(data?.routes)) return;
		for (const route of data.routes) {
			if (typeof route?.handler !== "function") continue;
			if (route.name && routeRegistrations.some((existing) => existing.name === route.name)) continue;
			if (routeRegistrations.some((existing) => existing.handler === route.handler)) continue;
			routeRegistrations.push(route);
		}
	});

	pi.events.on("magpie:webui:get-runtime", (callback: unknown) => {
		if (typeof callback === "function") callback(serverState?.runtime);
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = await loadConfig(ctx.cwd);
		if (config.webui?.enabled !== true) return;
		serverState ??= { activeSessions: 0 };
		serverState.activeSessions += 1;
		try {
			await ensureServerStarted(ctx, pi);
			if (ctx.hasUI && serverState?.runtime?.hostUrl) {
				ctx.ui.notify(`Web UI listening on ${serverState.runtime.hostUrl}`, "info");
			}
		} catch (error) {
			if (serverState) serverState.activeSessions = Math.max(0, serverState.activeSessions - 1);
			if (ctx.hasUI) ctx.ui.notify(`Failed to start Web UI: ${(error as Error).message}`, "error");
			await maybeStopServer();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const config = await loadConfig(ctx.cwd);
		if (config.webui?.enabled !== true) return;
		if (!serverState) return;
		serverState.activeSessions = Math.max(0, serverState.activeSessions - 1);
		await maybeStopServer();
	});
}
