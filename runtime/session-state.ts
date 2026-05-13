import type {
	AssistantChannel,
	HostedSessionKind,
	HostedSessionLocation,
	HostedSessionRunState,
	HostedSessionStatus,
	HostedSessionSummary,
	SessionFilter,
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

export function matchesHostedSessionFilter(summary: HostedSessionSummary, filter: SessionFilter | undefined, queryFields: Array<string | undefined>): boolean {
	if (!filter) return true;
	if (filter.kind && summary.kind !== filter.kind) return false;
	if (filter.location && summary.location !== filter.location) return false;
	if (filter.runState && summary.runState !== filter.runState) return false;
	if (filter.assistantChannel && summary.assistantChannel !== filter.assistantChannel) return false;
	if (!filter.includeArchived && summary.location === "archived") return false;
	if (filter.ownerKind && summary.owner?.kind !== filter.ownerKind) return false;
	if (!filter.query?.trim()) return true;
	const query = filter.query.trim().toLowerCase();
	return queryFields.some((value) => value?.toLowerCase().includes(query));
}
