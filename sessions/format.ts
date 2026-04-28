import type { SessionIndexEntry } from "./types.js";

export type SessionSort = "oldest" | "newest" | "best_match";

export function dedupeSessionEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
	const byPath = new Map<string, SessionIndexEntry>();
	for (const entry of entries) {
		const existing = byPath.get(entry.sessionPath);
		if (!existing) {
			byPath.set(entry.sessionPath, entry);
			continue;
		}
		const existingEndedAt = Date.parse(existing.endedAt);
		const nextEndedAt = Date.parse(entry.endedAt);
		if (!Number.isFinite(existingEndedAt) || nextEndedAt >= existingEndedAt) byPath.set(entry.sessionPath, entry);
	}
	return Array.from(byPath.values());
}

export function sessionOverlapsRange(entry: SessionIndexEntry, fromMs?: number, toMs?: number): boolean {
	const startedAt = Date.parse(entry.startedAt);
	const endedAt = Date.parse(entry.endedAt);
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return false;
	if (fromMs !== undefined && endedAt < fromMs) return false;
	if (toMs !== undefined && startedAt > toMs) return false;
	return true;
}

export function compareSessions(a: { entry: SessionIndexEntry; score: number }, b: { entry: SessionIndexEntry; score: number }, sort: SessionSort): number {
	if (sort === "best_match") {
		if (b.score !== a.score) return b.score - a.score;
		return Date.parse(b.entry.startedAt) - Date.parse(a.entry.startedAt);
	}
	if (sort === "oldest") return Date.parse(a.entry.startedAt) - Date.parse(b.entry.startedAt);
	return Date.parse(b.entry.startedAt) - Date.parse(a.entry.startedAt);
}

export function formatSessionListResult(entries: SessionIndexEntry[], meta: { query?: string; from?: string; to?: string; sort: SessionSort; limit: number }): string {
	const lines = [
		`**Count:** ${entries.length}`,
		`**Sort:** ${meta.sort}`,
		`**Limit:** ${meta.limit}`,
	];
	if (meta.query) lines.push(`**Query:** ${meta.query}`);
	if (meta.from) lines.push(`**From:** ${meta.from}`);
	if (meta.to) lines.push(`**To:** ${meta.to}`);
	if (entries.length === 0) return [...lines, "", "No indexed sessions matched those filters."].join("\n");
	return [
		...lines,
		"",
		...entries.map((entry, index) => [
			`${index + 1}. \`${entry.sessionPath}\``,
			`   - startedAt: ${entry.startedAt}`,
			`   - endedAt: ${entry.endedAt}`,
			`   - cwd: ${entry.cwd}`,
			`   - messageCount: ${entry.messageCount}`,
			`   - summary: ${entry.summary || "(none)"}`,
			`   - topics: ${entry.topics.length ? entry.topics.join(", ") : "(none)"}`,
			`   - filesModified: ${entry.filesModified.length ? entry.filesModified.join(", ") : "(none)"}`,
		].join("\n")),
	].join("\n");
}
