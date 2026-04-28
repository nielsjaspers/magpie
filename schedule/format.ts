import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ScheduleEntry } from "./types.js";

export function describeEntryStatus(entry: ScheduleEntry) {
	if (entry.cancelledAt) return `cancelled at ${entry.cancelledAt}`;
	const lastRun = entry.runs.at(-1);
	if (lastRun?.endedAt) return `completed (${lastRun.exitCode ?? 0}) at ${lastRun.endedAt}`;
	if (lastRun?.startedAt) return `running since ${lastRun.startedAt}`;
	if (entry.type === "recurring") return `recurring (${entry.cronExpr})`;
	if (entry.runAt && Date.parse(entry.runAt) < Date.now()) return `missed/unknown after ${entry.runAt}`;
	return entry.runAt ? `scheduled for ${entry.runAt}` : `scheduled (${entry.when})`;
}

export function formatEntry(entry: ScheduleEntry) {
	return [
		`${entry.id} · ${describeEntryStatus(entry)}`,
		`- type: ${entry.type}`,
		entry.type === "recurring" ? `- cron: ${entry.cronExpr}` : `- when: ${entry.runAt}`,
		`- task: ${entry.task}`,
		`- backend: ${entry.backend}`,
		`- cwd: ${entry.cwd}`,
		entry.mode ? `- mode: ${entry.mode}` : undefined,
		entry.sessionDir ? `- sessionDir: ${entry.sessionDir}` : undefined,
		`- runs: ${entry.runs.length}`,
	].filter(Boolean).join("\n");
}

function requireResultPlaceholder(path: string) {
	return `@@RESULT:${path}`;
}

export function formatLogs(entry: ScheduleEntry) {
	const runs = entry.type === "recurring" ? entry.runs.slice(-10) : entry.runs.slice(-1);
	if (runs.length === 0) return `No result yet for ${entry.id}\nStatus: ${describeEntryStatus(entry)}\nBackend: ${entry.backend}`;
	return runs.map((run, index) => [
		entry.type === "recurring" ? `Run ${entry.runs.length - runs.length + index + 1}` : "Run",
		`startedAt: ${run.startedAt}`,
		run.endedAt ? `endedAt: ${run.endedAt}` : undefined,
		typeof run.exitCode === "number" ? `exitCode: ${run.exitCode}` : undefined,
		run.sessionDir ? `sessionDir: ${run.sessionDir}` : undefined,
		"",
		existsSync(run.resultPath) ? undefined : `(missing result file: ${run.resultPath})`,
	].filter(Boolean).join("\n") + (existsSync(run.resultPath) ? `\n${requireResultPlaceholder(run.resultPath)}` : "")).join("\n\n---\n\n");
}

export async function expandLogResultPlaceholders(text: string) {
	const matches = [...text.matchAll(/@@RESULT:([^\n]+)/g)];
	let rendered = text;
	for (const match of matches) {
		const path = match[1];
		const body = existsSync(path) ? await readFile(path, "utf8") : `(missing result file: ${path})`;
		rendered = rendered.replace(match[0], body);
	}
	return rendered;
}
