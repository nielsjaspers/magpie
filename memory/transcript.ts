import type { HostedSessionSnapshot } from "../runtime/session-host-types.js";

export function messageToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
		.filter(Boolean)
		.join("\n");
}

export function sessionConversationText(ctx: any): string {
	const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
	return branch
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => {
			const role = entry.message?.role ?? "unknown";
			const text = messageToText(entry.message?.content).trim();
			return `## ${role}\n\n${text || "(no text)"}`;
		})
		.join("\n\n");
}

export function snapshotConversationText(snapshot: HostedSessionSnapshot | undefined): string {
	if (!snapshot?.messages?.length) return "";
	return snapshot.messages
		.map((message) => `## ${message.role}\n\n${message.text?.trim() || "(no text)"}`)
		.join("\n\n");
}
