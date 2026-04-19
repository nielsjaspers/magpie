import type { HostedSessionEvent, HostedSessionSnapshot, HostedSessionStatus } from "../runtime/session-host-types.js";

export interface WebUiServerConfig {
	port?: number;
	bind?: "tailscale" | "public" | "localhost" | string;
	publicUrl?: string;
	tailscaleUrl?: string;
}

export interface WebUiListSessionsResponse {
	sessions: Array<{
		sessionId: string;
		title?: string;
		kind: "coding" | "assistant";
		location: "local" | "remote" | "stubbed" | "archived";
		runState: "idle" | "running" | "aborting" | "error";
		createdAt: string;
		updatedAt: string;
		cwd?: string;
		assistantChannel?: "telegram" | "web" | "internal";
		assistantThreadId?: string;
	}>;
}

export interface WebUiSessionResponse {
	status: HostedSessionStatus;
	snapshot?: HostedSessionSnapshot;
}

export type WebUiStreamEvent = HostedSessionEvent;
