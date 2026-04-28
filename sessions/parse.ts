import { resolve } from "node:path";
import { extractTextFromUnknownContent } from "../runtime/session-content.js";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export function messageToText(message: { content?: unknown }): string {
	return extractTextFromUnknownContent(message.content) ?? "";
}

export function normalizeSessionPath(raw: string): string {
	return raw.trim().replace(/^`+|`+$/g, "").replace(/^\"+|\"+$/g, "").trim();
}

export function parseParentSessionPath(text: string): string | undefined {
	const markdownMatch = text.match(/\*\*Parent session:\*\*\s*`([^`]+)`/i);
	if (markdownMatch?.[1]) return normalizeSessionPath(markdownMatch[1]);
	const plainMatch = text.match(/Parent session:\s*([^\n]+)/i);
	if (plainMatch?.[1]) return normalizeSessionPath(plainMatch[1]);
	return undefined;
}

export function resolveSessionPath(inputPath: string, cwd: string): string {
	if (inputPath.startsWith("/")) return inputPath;
	if (inputPath.startsWith("~")) return inputPath.replace("~", process.env.HOME ?? "~");
	return resolve(cwd, inputPath);
}

export function findParentSessionPathFromCurrentBranch(ctx: { sessionManager: { getBranch(): SessionEntry[] } }): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message as { content?: unknown });
	for (let i = messages.length - 1; i >= 0; i--) {
		const path = parseParentSessionPath(messageToText(messages[i]!));
		if (path) return path;
	}
	return undefined;
}

export function parseDateBoundary(raw: string | undefined, boundary: "start" | "end"): number | undefined {
	if (!raw?.trim()) return undefined;
	const value = raw.trim();
	const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		const date = boundary === "start"
			? new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
			: new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
		const ts = date.getTime();
		return Number.isFinite(ts) ? ts : undefined;
	}
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}
