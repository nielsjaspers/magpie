import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { shellEscape } from "./runner-script.js";
import type { ScheduleBackend, ScheduleEntry, ScheduleType } from "./types.js";

const execFileAsync = promisify(execFile);
const CRON_BEGIN = "# MAGPIE-SCHEDULE-BEGIN";
const CRON_END = "# MAGPIE-SCHEDULE-END";

function formatAtTimestamp(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	const second = String(date.getSeconds()).padStart(2, "0");
	return `${year}${month}${day}${hour}${minute}.${second}`;
}

async function commandExists(command: string): Promise<boolean> {
	try {
		await execFileAsync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`]);
		return true;
	} catch {
		return false;
	}
}

export async function resolveCommandPath(command: string): Promise<string | undefined> {
	try {
		const result = await execFileAsync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
		const value = result.stdout.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

async function installCronLine(id: string, line: string) {
	const current = await getManagedCrontab();
	const next = [...current.filter((entry) => !entry.includes(`# ${id}`)), line];
	await writeManagedCrontab(next);
}

async function removeCronLine(id: string) {
	const current = await getManagedCrontab();
	await writeManagedCrontab(current.filter((entry) => !entry.includes(`# ${id}`)));
}

async function getManagedCrontab(): Promise<string[]> {
	let existing = "";
	try {
		const result = await execFileAsync("crontab", ["-l"], { encoding: "utf8" });
		existing = result.stdout;
	} catch (error: any) {
		existing = error?.stdout || "";
	}
	const lines = existing.split(/\r?\n/);
	const begin = lines.indexOf(CRON_BEGIN);
	const end = lines.indexOf(CRON_END);
	if (begin >= 0 && end > begin) return lines.slice(begin + 1, end).filter((line) => line.trim());
	return [];
}

async function writeManagedCrontab(managed: string[]) {
	let existing = "";
	try {
		const result = await execFileAsync("crontab", ["-l"], { encoding: "utf8" });
		existing = result.stdout;
	} catch (error: any) {
		existing = error?.stdout || "";
	}
	const lines = existing.split(/\r?\n/);
	const begin = lines.indexOf(CRON_BEGIN);
	const end = lines.indexOf(CRON_END);
	const head = begin >= 0 ? lines.slice(0, begin).filter((line) => line.trim()) : lines.filter((line) => line.trim());
	const tail = begin >= 0 && end > begin ? lines.slice(end + 1).filter((line) => line.trim()) : [];
	const next = [...head, CRON_BEGIN, ...managed, CRON_END, ...tail].join("\n") + "\n";
	await new Promise<void>((resolve, reject) => {
		const child = execFile("crontab", ["-"], (error) => error ? reject(error) : resolve());
		child.stdin?.end(next, "utf8");
	});
}

export async function chooseBackend(type: ScheduleType): Promise<ScheduleBackend> {
	const hasCron = await commandExists("crontab");
	if (type === "recurring") {
		if (!hasCron) throw new Error("Recurring schedules require 'crontab'.");
		return "cron_fallback";
	}
	if (process.platform === "darwin" && hasCron) return "cron_fallback";
	if (await commandExists("at")) return "at";
	if (hasCron) return "cron_fallback";
	throw new Error("Neither 'at' nor 'crontab' is available on this system.");
}

export async function scheduleEntry(entry: ScheduleEntry): Promise<ScheduleEntry> {
	if (entry.type === "one-shot" && entry.backend === "at") {
		const atTime = formatAtTimestamp(new Date(entry.runAt!));
		const result = await new Promise<string>((resolve, reject) => {
			const child = execFile("at", ["-t", atTime], (error, stdout, stderr) => {
				if (error) reject(new Error(stderr || stdout || error.message));
				else resolve(`${stdout}${stderr}`);
			});
			child.stdin?.end(`${entry.scriptPath}\n`, "utf8");
		});
		const jobId = result.match(/job\s+(\d+)/i)?.[1];
		return { ...entry, atJobId: jobId };
	}
	const cronId = `magpie-schedule-${entry.id}`;
	const cronLine = entry.type === "recurring"
		? `${entry.cronExpr} /bin/bash ${shellEscape(entry.scriptPath)} # ${cronId}`
		: `${new Date(entry.runAt!).getMinutes()} ${new Date(entry.runAt!).getHours()} ${new Date(entry.runAt!).getDate()} ${new Date(entry.runAt!).getMonth() + 1} * /bin/bash ${shellEscape(entry.scriptPath)} # ${cronId}`;
	await installCronLine(cronId, cronLine);
	return { ...entry, cronId };
}

export async function cancelScheduledEntry(entry: ScheduleEntry) {
	if (entry.atJobId && await commandExists("atrm")) {
		try { await execFileAsync("atrm", [entry.atJobId]); } catch {}
	}
	if (entry.cronId) {
		try { await removeCronLine(entry.cronId); } catch {}
	}
	if (entry.scriptPath?.trim()) {
		try { await rm(entry.scriptPath, { force: true }); } catch {}
	}
}
