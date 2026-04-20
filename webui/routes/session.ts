import type {
	AssistantChannel,
	CreateSessionInput,
	SendMessageInput,
	SessionFilter,
	SessionHost,
} from "../../runtime/session-host-types.js";

export function normalizeAssistantChannel(value: string | null | undefined): AssistantChannel | undefined {
	if (value === "telegram" || value === "web" || value === "internal") return value;
	return undefined;
}

export function parseSessionFilter(searchParams: URLSearchParams): SessionFilter {
	const ownerKind = searchParams.get("ownerKind");
	return {
		kind: searchParams.get("kind") === "assistant" || searchParams.get("kind") === "coding"
			? searchParams.get("kind") as SessionFilter["kind"]
			: undefined,
		location: searchParams.get("location") as SessionFilter["location"] ?? undefined,
		runState: searchParams.get("runState") as SessionFilter["runState"] ?? undefined,
		ownerKind: ownerKind === "local_tui" || ownerKind === "remote_web" || ownerKind === "remote_dispatch" || ownerKind === "schedule" || ownerKind === "system"
			? ownerKind as SessionFilter["ownerKind"]
			: undefined,
		assistantChannel: normalizeAssistantChannel(searchParams.get("assistantChannel")),
		query: searchParams.get("query") || undefined,
		includeArchived: searchParams.get("includeArchived") === "1",
		limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
	};
}

export function parseCreateSessionInput(body: Record<string, unknown>, defaultModelRef: string): CreateSessionInput {
	const kind = body.kind === "assistant" || body.kind === "coding" ? body.kind : "assistant";
	const origin = body.origin === "local" || body.origin === "remote" || body.origin === "assistant" || body.origin === "imported" || body.origin === "scheduled"
		? body.origin
		: kind === "assistant" ? "assistant" : "remote";
	return {
		kind,
		origin,
		title: typeof body.title === "string" ? body.title : undefined,
		cwd: typeof body.cwd === "string" ? body.cwd : undefined,
		workspaceMode: body.workspaceMode === "attached" ? "attached" : "none",
		assistantChannel: normalizeAssistantChannel(typeof body.assistantChannel === "string" ? body.assistantChannel : undefined) ?? "internal",
		assistantThreadId: typeof body.assistantThreadId === "string" ? body.assistantThreadId : undefined,
		modelRef: typeof body.modelRef === "string" && body.modelRef.trim() ? body.modelRef : defaultModelRef,
	};
}

export function parseSendMessageInput(body: Record<string, unknown>, defaultModelRef: string): SendMessageInput {
	return {
		text: String(body.text || ""),
		modelRef: typeof body.modelRef === "string" && body.modelRef.trim() ? body.modelRef : defaultModelRef,
		source: body.source === "tui" || body.source === "web" || body.source === "telegram" || body.source === "schedule" || body.source === "system"
			? body.source
			: undefined,
	};
}

export async function listSessionRoute(host: SessionHost, filter?: SessionFilter) {
	const sessions = await host.listSessions(filter);
	return { sessions };
}

export async function createSessionRoute(host: SessionHost, input: CreateSessionInput) {
	if (input.kind !== "assistant") {
		throw new Error("Only assistant session creation is supported by the current host");
	}
	const metadata = await host.createSession({
		...input,
		owner: input.owner ?? (input.assistantChannel === "web"
			? { kind: "remote_web", hostId: host.hostId, displayName: "Remote web assistant session" }
			: undefined),
	});
	return { sessionId: metadata.sessionId, metadata };
}

export async function getSessionStatusRoute(host: SessionHost, sessionId: string, modelRef?: string) {
	const status = await host.getStatus(sessionId, modelRef);
	if (!status) throw new Error(`Session not found: ${sessionId}`);
	return status;
}

export async function getSessionSnapshotRoute(host: SessionHost, sessionId: string, modelRef?: string, limit = 50) {
	const snapshot = await host.getSnapshot(sessionId, modelRef, limit);
	if (!snapshot) throw new Error(`Session not found: ${sessionId}`);
	return snapshot;
}

export async function sendSessionMessageRoute(host: SessionHost, sessionId: string, input: SendMessageInput) {
	const accepted = await host.sendUserMessage(sessionId, input);
	const snapshot = await host.getSnapshot(sessionId, input.modelRef, 8);
	const text = snapshot?.messages.at(-1)?.role === "assistant" ? snapshot.messages.at(-1)?.text || "" : "";
	return { sessionId, accepted, text };
}
