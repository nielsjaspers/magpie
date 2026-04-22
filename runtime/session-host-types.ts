export type HostedSessionKind = "coding" | "assistant";
export type SessionOrigin = "local" | "remote" | "assistant" | "imported" | "scheduled";
export type WorkspaceMode = "none" | "attached";
export type HostedSessionRunState = "idle" | "running" | "aborting" | "error";
export type HostedSessionLocation = "local" | "remote" | "stubbed" | "archived";
export type AssistantChannel = "telegram" | "web" | "internal";

export interface SessionOwner {
	kind: "local_tui" | "remote_web" | "remote_dispatch" | "schedule" | "system";
	hostId: string;
	actorId?: string;
	displayName?: string;
}

export interface SessionWatcher {
	id: string;
	kind: "web" | "local_status" | "telegram" | "system";
	hostId: string;
	actorId?: string;
}

export interface HostedSessionMetadata {
	sessionId: string;
	kind: HostedSessionKind;
	origin: SessionOrigin;
	location: HostedSessionLocation;
	runState: HostedSessionRunState;
	createdAt: string;
	updatedAt: string;
	title?: string;
	summary?: string;
	owner?: SessionOwner;
	workspaceMode: WorkspaceMode;
	cwd?: string;
	sourceSessionPath?: string;
	dispatchedFromHostId?: string;
	dispatchedToHostId?: string;
	remoteSessionId?: string;
	assistantChannel?: AssistantChannel;
	assistantThreadId?: string;
}

export interface SessionFilter {
	kind?: HostedSessionKind;
	location?: HostedSessionLocation;
	runState?: HostedSessionRunState;
	ownerKind?: SessionOwner["kind"];
	query?: string;
	assistantChannel?: AssistantChannel;
	includeArchived?: boolean;
	limit?: number;
}

export interface HostedSessionSummary {
	sessionId: string;
	title?: string;
	kind: HostedSessionKind;
	location: HostedSessionLocation;
	runState: HostedSessionRunState;
	createdAt: string;
	updatedAt: string;
	cwd?: string;
	owner?: SessionOwner;
	watcherCount?: number;
	assistantChannel?: AssistantChannel;
	assistantThreadId?: string;
	sessionPath?: string;
	loaded?: boolean;
	messageCount?: number;
}

export interface HostedSessionStatus extends HostedSessionSummary {
	activeTurnId?: string;
	queueDepth?: number;
	lastError?: string;
	watchers?: SessionWatcher[];
}

export interface HostedSessionSnapshot {
	metadata: HostedSessionMetadata;
	status: HostedSessionStatus;
	messages: Array<{
		role: string;
		text?: string;
	}>;
}

export type HostedSessionEvent =
	| { type: "snapshot"; session: HostedSessionSnapshot }
	| { type: "status"; status: HostedSessionStatus }
	| { type: "text_delta"; delta: string }
	| { type: "message_complete"; message?: unknown }
	| { type: "tool_start"; toolName: string; args?: unknown }
	| { type: "tool_end"; toolName: string; result?: unknown; isError?: boolean }
	| { type: "ownership_changed"; owner?: SessionOwner }
	| { type: "error"; error: string };

export type HostedSessionListener = (event: HostedSessionEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface CreateSessionInput {
	kind: HostedSessionKind;
	origin: SessionOrigin;
	title?: string;
	cwd?: string;
	workspaceMode?: WorkspaceMode;
	owner?: SessionOwner;
	assistantChannel?: AssistantChannel;
	assistantThreadId?: string;
	modelRef?: string;
}

export interface ExportedSessionBundle {
	metadata: HostedSessionMetadata;
	sessionJsonl: Uint8Array;
	workspace?: {
		archive: Uint8Array;
		format: "tar.gz";
	};
}

export interface ImportSessionInput {
	bundle: ExportedSessionBundle;
	targetCwd?: string;
	owner?: SessionOwner;
}

export interface SendMessageInput {
	text: string;
	modelRef?: string;
	actor?: SessionOwner;
	source?: "tui" | "web" | "telegram" | "schedule" | "system";
}

export type ArchiveReason = "dispatched" | "fetched" | "completed" | "cancelled" | "manual";

export interface AcceptedMessage {
	sessionId: string;
	accepted: boolean;
	queued: boolean;
	runState: HostedSessionRunState;
}

export interface HostedSessionHandle {
	metadata: HostedSessionMetadata;
	getPiSession(modelRef?: string): Promise<unknown>;
	getStatus(modelRef?: string): Promise<HostedSessionStatus | undefined>;
	getSnapshot(modelRef?: string, limit?: number): Promise<HostedSessionSnapshot | undefined>;
	subscribe(listener: HostedSessionListener, watcher?: SessionWatcher, modelRef?: string): Promise<Unsubscribe>;
	sendUserMessage(input: SendMessageInput): Promise<AcceptedMessage>;
	interrupt(actor?: SessionOwner, modelRef?: string): Promise<void>;
	claimOwnership(owner: SessionOwner): Promise<void>;
	releaseOwnership(owner?: SessionOwner): Promise<void>;
	archive(reason?: ArchiveReason): Promise<void>;
	export(modelRef?: string): Promise<ExportedSessionBundle>;
}

export interface SessionHost {
	hostId: string;
	hostRole: "local" | "remote";
	getSession(sessionId: string, modelRef?: string): Promise<HostedSessionHandle | undefined>;
	createSession(input: CreateSessionInput): Promise<HostedSessionHandle>;
	importSession(input: ImportSessionInput): Promise<HostedSessionHandle>;
	exportSession(sessionId: string, modelRef?: string): Promise<ExportedSessionBundle>;
	sendUserMessage(sessionId: string, input: SendMessageInput): Promise<AcceptedMessage>;
	listSessions(filter?: SessionFilter): Promise<HostedSessionSummary[]>;
	getStatus(sessionId: string, modelRef?: string): Promise<HostedSessionStatus | undefined>;
	getSnapshot(sessionId: string, modelRef?: string, limit?: number): Promise<HostedSessionSnapshot | undefined>;
	subscribe(sessionId: string, listener: HostedSessionListener, watcher?: SessionWatcher, modelRef?: string): Promise<Unsubscribe>;
	interrupt(sessionId: string, actor?: SessionOwner, modelRef?: string): Promise<void>;
	claimOwnership(sessionId: string, owner: SessionOwner): Promise<void>;
	releaseOwnership(sessionId: string, owner?: SessionOwner): Promise<void>;
	archiveSession(sessionId: string, reason?: ArchiveReason): Promise<void>;
}
