import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostedSessionEvent, HostedSessionSnapshot, HostedSessionStatus, SessionOwner } from "../runtime/session-host-types.js";

export interface WebUiServerConfig {
	port?: number;
	bind?: "tailscale" | "public" | "localhost" | string;
	publicUrl?: string;
	tailscaleUrl?: string;
	tools?: string[];
}

export interface WebUiRequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	requestUrl: URL;
	runtime: unknown;
	readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
	sendJson: (res: ServerResponse, status: number, body: unknown) => void;
	getSessionIdFromRequestPath: (pathname: string) => { sessionId: string; suffix: string } | undefined;
}

export interface WebUiRouteRegistration {
	name?: string;
	handler: (ctx: WebUiRequestContext) => Promise<boolean> | boolean;
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
		owner?: SessionOwner;
		assistantChannel?: "telegram" | "web" | "internal";
		assistantThreadId?: string;
	}>;
}

export interface WebUiSessionResponse {
	status: HostedSessionStatus;
	snapshot?: HostedSessionSnapshot;
}

export type WebUiStreamEvent = HostedSessionEvent;
