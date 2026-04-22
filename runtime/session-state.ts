import type {
	AssistantChannel,
	HostedSessionKind,
	HostedSessionLocation,
	HostedSessionRunState,
	HostedSessionStatus,
	HostedSessionSummary,
	SessionOwner,
	SessionWatcher,
} from "./session-host-types.js";

export interface BuildHostedSessionSummaryInput {
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
}

export function buildHostedSessionSummary(input: BuildHostedSessionSummaryInput): HostedSessionSummary {
	return {
		sessionId: input.sessionId,
		title: input.title,
		kind: input.kind,
		location: input.location,
		runState: input.runState,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		cwd: input.cwd,
		owner: input.owner,
		watcherCount: input.watcherCount,
		assistantChannel: input.assistantChannel,
		assistantThreadId: input.assistantThreadId,
		sessionPath: input.sessionPath,
		loaded: input.loaded,
	};
}

export interface BuildHostedSessionStatusInput {
	summary: HostedSessionSummary;
	activeTurnId?: string;
	messageCount?: number;
	queueDepth?: number;
	lastError?: string;
	watchers?: SessionWatcher[];
}

export function buildHostedSessionStatus(input: BuildHostedSessionStatusInput): HostedSessionStatus {
	return {
		...input.summary,
		activeTurnId: input.activeTurnId,
		messageCount: input.messageCount,
		queueDepth: input.queueDepth,
		lastError: input.lastError,
		watchers: input.watchers,
	};
}
