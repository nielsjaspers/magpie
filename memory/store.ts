import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { MemoryEntry } from "./types.js";

function getBaseDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
}

export function getDefaultMemoryStorePath(): string {
	return resolve(getBaseDir(), "magpie-memories.jsonl");
}

async function ensureParent(path: string) {
	await mkdir(dirname(path), { recursive: true });
}

export async function loadMemories(path = getDefaultMemoryStorePath()): Promise<MemoryEntry[]> {
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as MemoryEntry];
			} catch {
				return [];
			}
		});
}

export async function saveMemories(memories: MemoryEntry[], path = getDefaultMemoryStorePath()) {
	await ensureParent(path);
	await writeFile(path, `${memories.map((memory) => JSON.stringify(memory)).join("\n")}${memories.length ? "\n" : ""}`, "utf8");
}

export async function addMemory(
	content: string,
	category?: string,
	source: "user" | "auto" = "user",
	path = getDefaultMemoryStorePath(),
): Promise<MemoryEntry> {
	const memories = await loadMemories(path);
	const entry: MemoryEntry = {
		id: randomUUID(),
		content,
		createdAt: new Date().toISOString(),
		source,
		category,
		active: true,
	};
	memories.push(entry);
	await saveMemories(memories, path);
	return entry;
}

export async function forgetMemory(idOrText: string, path = getDefaultMemoryStorePath()): Promise<MemoryEntry | undefined> {
	const memories = await loadMemories(path);
	const normalized = idOrText.toLowerCase();
	const target = memories.find((memory) => memory.active && (memory.id === idOrText || memory.content.toLowerCase().includes(normalized)));
	if (!target) return undefined;
	target.active = false;
	await saveMemories(memories, path);
	return target;
}

export function searchMemories(memories: MemoryEntry[], query: string): MemoryEntry[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return memories
		.filter((memory) => memory.active)
		.map((memory) => ({
			memory,
			score: tokens.reduce((score, token) => {
				if (memory.content.toLowerCase().includes(token)) score += 2;
				if (memory.category?.toLowerCase().includes(token)) score += 1;
				return score;
			}, 0),
		}))
		.filter((item) => item.score > 0 || memoryString(item.memory).includes(query.toLowerCase()))
		.sort((a, b) => b.score - a.score)
		.map((item) => item.memory);
}

function memoryString(memory: MemoryEntry): string {
	return `${memory.category ?? ""} ${memory.content}`.toLowerCase();
}
