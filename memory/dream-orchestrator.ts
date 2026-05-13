import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostedSessionHandle, HostedSessionSnapshot, SessionHost } from "../runtime/session-host-types.js";
import { getJson, postJson } from "./host-client.js";

const DREAM_TOOL_NAMES = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"read_memory",
	"write_memory",
	"memory_subagent",
	"calendar_create_event",
];

export function getDirectAssistantHost(pi: ExtensionAPI): SessionHost | undefined {
	let runtime: { host?: SessionHost } | undefined;
	pi.events.emit("magpie:webui:get-runtime", (value: unknown) => {
		runtime = value as { host?: SessionHost } | undefined;
	});
	return runtime?.host;
}

export function modelRefFromContext(ctx: any): string | undefined {
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

export async function createDreamOrchestratorSession(host: SessionHost, modelRef: string): Promise<HostedSessionHandle> {
	return await host.createSession({
		kind: "assistant",
		origin: "assistant",
		title: "Dream orchestrator",
		assistantChannel: "internal",
		assistantThreadId: `dream-${randomUUID()}`,
		workspaceMode: "none",
		modelRef,
		toolNames: DREAM_TOOL_NAMES,
	});
}

export async function createRemoteDreamOrchestratorSession(hostUrl: string, modelRef: string): Promise<HostedSessionHandle> {
	const created = await postJson<{ sessionId: string }>(hostUrl, "/api/v1/sessions", {
		kind: "assistant",
		origin: "assistant",
		title: "Dream orchestrator",
		assistantChannel: "internal",
		assistantThreadId: `dream-${randomUUID()}`,
		workspaceMode: "none",
		modelRef,
		toolNames: DREAM_TOOL_NAMES,
	});
	const session = await getJson<HostedSessionSnapshot>(hostUrl, `/api/v1/sessions/${encodeURIComponent(created.sessionId)}/snapshot`, { modelRef }).catch((): undefined => undefined);
	return { metadata: { sessionId: created.sessionId }, getSnapshot: async (): Promise<HostedSessionSnapshot | undefined> => session } as unknown as HostedSessionHandle;
}

export async function promptDreamOrchestrator(session: HostedSessionHandle, modelRef: string, text: string): Promise<{ text: string }> {
	await session.sendUserMessage({ text, modelRef, source: "system" });
	const snapshot = await session.getSnapshot(modelRef, 12);
	const lastAssistant = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === "assistant");
	return { text: lastAssistant?.text?.trim() || "" };
}

export async function promptRemoteDreamOrchestrator(hostUrl: string, sessionId: string, modelRef: string, text: string): Promise<{ text: string }> {
	return await postJson<{ text: string }>(hostUrl, `/api/v1/sessions/${encodeURIComponent(sessionId)}/message`, { text, modelRef });
}
