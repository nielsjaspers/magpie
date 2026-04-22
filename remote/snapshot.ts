import type { SerializedSessionBundle } from "./transport.js";

export interface RemoteBundleMessage {
	role: string;
	text?: string;
}

export interface RemoteBundleSnapshot {
	metadata: SerializedSessionBundle["metadata"];
	messages: RemoteBundleMessage[];
}

function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (Array.isArray(content)) {
		const text = content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
		return text || undefined;
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim() || undefined;
		if (Array.isArray(record.content)) return extractText(record.content);
		if (typeof record.content === "string") return record.content.trim() || undefined;
	}
	return undefined;
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
			messages.push({ role, text: extractText(message?.content) ?? extractText(entry.content) });
		} catch {
			continue;
		}
	}
	return {
		metadata: bundle.metadata,
		messages: messages.slice(-Math.max(1, limit)),
	};
}
