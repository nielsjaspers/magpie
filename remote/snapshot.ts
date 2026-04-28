import type { SerializedSessionBundle } from "./transport.js";
import { extractTextFromUnknownContent } from "../runtime/session-content.js";

export interface RemoteBundleMessage {
	role: string;
	text?: string;
}

export interface RemoteBundleSnapshot {
	metadata: SerializedSessionBundle["metadata"];
	messages: RemoteBundleMessage[];
}

export function buildRemoteBundleSnapshot(bundle: SerializedSessionBundle, limit = 50): RemoteBundleSnapshot {
	const raw = Buffer.from(bundle.sessionJsonlBase64, "base64").toString("utf8");
	const messages: RemoteBundleMessage[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as Record<string, unknown>;
			if (entry.type !== "message") continue;
			const message = entry.message as Record<string, unknown> | undefined;
			const role = typeof message?.role === "string" ? message.role : typeof entry.role === "string" ? entry.role : "unknown";
			messages.push({ role, text: extractTextFromUnknownContent(message?.content) ?? extractTextFromUnknownContent(entry.content) });
		} catch {
			continue;
		}
	}
	return {
		metadata: bundle.metadata,
		messages: messages.slice(-Math.max(1, limit)),
	};
}
