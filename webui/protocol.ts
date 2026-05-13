import type {
	AcceptedMessage,
	CreateSessionInput,
	HostedSessionEvent,
	HostedSessionMetadata,
	HostedSessionSnapshot,
	HostedSessionStatus,
	HostedSessionSummary,
	SendMessageInput,
} from "../runtime/session-host-types.js";

export interface SessionListResponse {
	sessions: HostedSessionSummary[];
}

export interface SessionCreateRequest extends CreateSessionInput {}

export interface SessionCreateResponse {
	sessionId: string;
	metadata: HostedSessionMetadata;
	created?: boolean;
}

export interface SessionMessageRequest extends SendMessageInput {}

export interface SessionMessageResponse {
	sessionId: string;
	text: string;
	accepted: AcceptedMessage;
	toolEvents?: Array<{
		type: "start" | "end";
		toolName: string;
		args?: unknown;
		result?: string;
		isError?: boolean;
	}>;
}

export interface SessionOkResponse {
	ok: boolean;
}

export type SessionStatusResponse = HostedSessionStatus;
export type SessionSnapshotResponse = HostedSessionSnapshot;
export type SessionStreamEvent = HostedSessionEvent;
