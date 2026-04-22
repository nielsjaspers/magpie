import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { PreferenceEntry } from "./types.js";

function getBaseDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
}

export function getLegacyMemoryStorePath(): string {
	return resolve(getBaseDir(), "magpie-memories.jsonl");
}

export function getDefaultPreferenceStorePath(): string {
	return resolve(getBaseDir(), "magpie-preferences.jsonl");
}

async function ensureParent(path: string) {
	await mkdir(dirname(path), { recursive: true });
}

async function resolveReadablePath(path = getDefaultPreferenceStorePath()): Promise<string> {
	if (existsSync(path)) return path;
	if (path === getDefaultPreferenceStorePath() && existsSync(getLegacyMemoryStorePath())) return getLegacyMemoryStorePath();
	return path;
}

export async function loadPreferences(path = getDefaultPreferenceStorePath()): Promise<PreferenceEntry[]> {
	const readablePath = await resolveReadablePath(path);
	if (!existsSync(readablePath)) return [];
	const raw = await readFile(readablePath, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as PreferenceEntry];
			} catch {
				return [];
			}
		});
}

export async function savePreferences(preferences: PreferenceEntry[], path = getDefaultPreferenceStorePath()) {
	await ensureParent(path);
	await writeFile(path, `${preferences.map((preference) => JSON.stringify(preference)).join("\n")}${preferences.length ? "\n" : ""}`, "utf8");
}

export async function addPreference(
	content: string,
	category?: string,
	source: "user" | "auto" = "user",
	path = getDefaultPreferenceStorePath(),
): Promise<PreferenceEntry> {
	const preferences = await loadPreferences(path);
	const entry: PreferenceEntry = {
		id: randomUUID(),
		content,
		createdAt: new Date().toISOString(),
		source,
		category,
		active: true,
	};
	preferences.push(entry);
	await savePreferences(preferences, path);
	return entry;
}

export async function forgetPreference(idOrText: string, path = getDefaultPreferenceStorePath()): Promise<PreferenceEntry | undefined> {
	const preferences = await loadPreferences(path);
	const normalized = idOrText.toLowerCase();
	const target = preferences.find((preference) => preference.active && (preference.id === idOrText || preference.content.toLowerCase().includes(normalized)));
	if (!target) return undefined;
	target.active = false;
	await savePreferences(preferences, path);
	return target;
}

export function searchPreferences(preferences: PreferenceEntry[], query: string): PreferenceEntry[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return preferences
		.filter((preference) => preference.active)
		.map((preference) => ({
			preference,
			score: tokens.reduce((score, token) => {
				if (preference.content.toLowerCase().includes(token)) score += 2;
				if (preference.category?.toLowerCase().includes(token)) score += 1;
				return score;
			}, 0),
		}))
		.filter((item) => item.score > 0 || preferenceString(item.preference).includes(query.toLowerCase()))
		.sort((a, b) => b.score - a.score)
		.map((item) => item.preference);
}

function preferenceString(preference: PreferenceEntry): string {
	return `${preference.category ?? ""} ${preference.content}`.toLowerCase();
}
