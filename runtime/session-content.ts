export function sanitizeSessionIdForFilename(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function extractTextFromUnknownContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(content)) {
		const parts = content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object") {
					const record = part as Record<string, unknown>;
					if (typeof record.text === "string") return record.text;
					if (typeof record.content === "string") return record.content;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
		return parts || undefined;
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") {
			const trimmed = record.text.trim();
			return trimmed || undefined;
		}
		if (typeof record.content === "string") {
			const trimmed = record.content.trim();
			return trimmed || undefined;
		}
		if (Array.isArray(record.content)) return extractTextFromUnknownContent(record.content);
		if (record.message && typeof record.message === "object") {
			return extractTextFromUnknownContent((record.message as Record<string, unknown>).content);
		}
	}
	return undefined;
}

export function extractTextFromSessionMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	return extractTextFromUnknownContent(record.content)
		?? extractTextFromUnknownContent(record.message)
		?? extractTextFromUnknownContent(record.parts);
}
