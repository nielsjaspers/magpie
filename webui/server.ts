import type { SessionHost } from "../runtime/session-host-types.js";
import type { WebUiServerConfig } from "./types.js";

export interface WebUiServerRuntime {
	host: SessionHost;
	config: WebUiServerConfig;
}

export function createWebUiServerRuntime(host: SessionHost, config: WebUiServerConfig = {}): WebUiServerRuntime {
	return { host, config };
}

export function describeWebUiServer(runtime: WebUiServerRuntime) {
	return {
		hostId: runtime.host.hostId,
		hostRole: runtime.host.hostRole,
		port: runtime.config.port ?? 4711,
		bind: runtime.config.bind ?? "tailscale",
		publicUrl: runtime.config.publicUrl,
		tailscaleUrl: runtime.config.tailscaleUrl,
	};
}
