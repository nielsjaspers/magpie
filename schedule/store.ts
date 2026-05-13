import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ScheduleEntry, ScheduleRunRecord, ScheduleStore } from "./types.js";

export function createScheduleStore(baseDir = resolve(homedir(), ".pi/agent/magpie-schedules")): ScheduleStore {
	return {
		baseDir,
		scriptsDir: resolve(baseDir, "scripts"),
		resultsDir: resolve(baseDir, "results"),
		indexPath: resolve(baseDir, "index.json"),
	};
}

export async function ensureStore(store: ScheduleStore) {
	await mkdir(store.scriptsDir, { recursive: true });
	await mkdir(store.resultsDir, { recursive: true });
	await mkdir(dirname(store.indexPath), { recursive: true });
}

function normalizeRunRecord(entry: any): ScheduleRunRecord | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	if (typeof entry.resultPath !== "string" || !entry.resultPath.trim()) return undefined;
	const startedAt = typeof entry.startedAt === "string" && entry.startedAt.trim() ? entry.startedAt : entry.endedAt || "";
	if (!startedAt) return undefined;
	return {
		startedAt,
		endedAt: typeof entry.endedAt === "string" ? entry.endedAt : undefined,
		exitCode: typeof entry.exitCode === "number" ? entry.exitCode : undefined,
		resultPath: entry.resultPath,
		statePath: typeof entry.statePath === "string" ? entry.statePath : undefined,
		sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : undefined,
	};
}

function normalizeEntry(entry: any): ScheduleEntry | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	if (typeof entry.id !== "string" || typeof entry.task !== "string" || typeof entry.cwd !== "string") return undefined;
	const runs = Array.isArray(entry.runs)
		? entry.runs.map(normalizeRunRecord).filter(Boolean) as ScheduleRunRecord[]
		: [];
	if (runs.length === 0 && typeof entry.resultPath === "string") {
		const migrated = normalizeRunRecord({
			startedAt: entry.createdAt,
			endedAt: undefined,
			exitCode: undefined,
			resultPath: entry.resultPath,
			statePath: entry.statePath,
			sessionDir: entry.sessionDir,
		});
		if (migrated) runs.push(migrated);
	}
	return {
		id: entry.id,
		type: entry.type === "recurring" ? "recurring" : "one-shot",
		cwd: entry.cwd,
		task: entry.task,
		model: typeof entry.model === "string" ? entry.model : undefined,
		mode: typeof entry.mode === "string" ? entry.mode : undefined,
		when: typeof entry.when === "string" ? entry.when : "",
		runAt: typeof entry.runAt === "string" ? entry.runAt : undefined,
		cronExpr: typeof entry.cronExpr === "string" ? entry.cronExpr : undefined,
		backend: entry.backend === "cron_fallback" ? "cron_fallback" : "at",
		scriptPath: typeof entry.scriptPath === "string" ? entry.scriptPath : "",
		resultPath: typeof entry.resultPath === "string" ? entry.resultPath : runs.at(-1)?.resultPath,
		statePath: typeof entry.statePath === "string" ? entry.statePath : runs.at(-1)?.statePath,
		sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : undefined,
		createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
		notify: entry.notify !== false,
		atJobId: typeof entry.atJobId === "string" ? entry.atJobId : undefined,
		cronId: typeof entry.cronId === "string" ? entry.cronId : undefined,
		cancelledAt: typeof entry.cancelledAt === "string" ? entry.cancelledAt : undefined,
		runs,
	};
}

export async function readIndex(store: ScheduleStore): Promise<ScheduleEntry[]> {
	await ensureStore(store);
	if (!existsSync(store.indexPath)) return [];
	try {
		const raw = JSON.parse(await readFile(store.indexPath, "utf8")) as unknown[];
		return Array.isArray(raw) ? raw.map(normalizeEntry).filter(Boolean) as ScheduleEntry[] : [];
	} catch {
		return [];
	}
}

export async function writeIndex(store: ScheduleStore, entries: ScheduleEntry[]) {
	await ensureStore(store);
	await writeFile(store.indexPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}
