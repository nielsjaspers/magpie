import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { PendingIndexEntry, SessionIndexEntry } from "./types.js";

function getBaseDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
}

export function getSessionIndexPath(): string {
	return resolve(getBaseDir(), "magpie-session-index.jsonl");
}

export function getPendingIndexPath(): string {
	return resolve(getBaseDir(), "magpie-index-pending.jsonl");
}

async function ensureParent(path: string) {
	await mkdir(dirname(path), { recursive: true });
}

async function readJsonl<T>(path: string): Promise<T[]> {
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as T];
			} catch {
				return [];
			}
		});
}

async function writeJsonl(path: string, items: unknown[]) {
	await ensureParent(path);
	await writeFile(path, `${items.map((item) => JSON.stringify(item)).join("\n")}${items.length ? "\n" : ""}`, "utf8");
}

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
	return readJsonl<SessionIndexEntry>(getSessionIndexPath());
}

export async function saveSessionIndex(entries: SessionIndexEntry[], maxEntries = 500): Promise<void> {
	const trimmed = entries.slice(-Math.max(1, maxEntries));
	await writeJsonl(getSessionIndexPath(), trimmed);
}

export async function appendIndexEntry(entry: SessionIndexEntry, maxEntries = 500): Promise<void> {
	const entries = await loadSessionIndex();
	entries.push(entry);
	await saveSessionIndex(entries, maxEntries);
}

export async function upsertIndexEntry(entry: SessionIndexEntry, maxEntries = 500): Promise<void> {
	const entries = await loadSessionIndex();
	const filtered = entries.filter((existing) => existing.sessionPath !== entry.sessionPath);
	filtered.push(entry);
	await saveSessionIndex(filtered, maxEntries);
}

export async function loadPendingIndexEntries(): Promise<PendingIndexEntry[]> {
	return readJsonl<PendingIndexEntry>(getPendingIndexPath());
}

export async function addPendingIndexEntry(entry: PendingIndexEntry): Promise<void> {
	const entries = await loadPendingIndexEntries();
	if (!entries.some((existing) => existing.sessionPath === entry.sessionPath)) entries.push(entry);
	await writeJsonl(getPendingIndexPath(), entries);
}

export async function updatePendingIndexEntries(entries: PendingIndexEntry[]): Promise<void> {
	await writeJsonl(getPendingIndexPath(), entries);
}

export function scoreSessionEntry(entry: SessionIndexEntry, query: string): number {
	const q = query.toLowerCase();
	let score = 0;
	for (const text of [entry.summary, ...entry.topics, ...entry.filesModified]) {
		const hay = text.toLowerCase();
		if (hay.includes(q)) score += 8;
		for (const token of q.split(/\s+/).filter(Boolean)) {
			if (hay.includes(token)) score += 1;
		}
	}
	return score;
}
