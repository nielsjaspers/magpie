import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as chrono from "chrono-node";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	getActiveConfigScope,
	getConfigBaseDir,
	getMode,
	loadAuthConfig,
	loadConfig,
	resolvePromptText,
	resolveSubagentModelRef,
} from "../config/config.js";
import type { MagpieAuthConfig, MagpieConfig, ThinkingLevel } from "../config/types.js";
import { getActiveModeName } from "../pa/shared/mode.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import type {
	ScheduleBackend,
	ScheduleEntry,
	ScheduleRunRecord,
	ScheduleStore,
	ScheduleType,
} from "./types.js";

const execFileAsync = promisify(execFile);
const CRON_BEGIN = "# MAGPIE-SCHEDULE-BEGIN";
const CRON_END = "# MAGPIE-SCHEDULE-END";
const SCHEDULE_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const COMMON_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SCHEDULE_BACKGROUND_PROMPT = [
	"You are running as a scheduled background Magpie task.",
	"Actually perform the requested work in the working directory using tools when needed.",
	"Do not merely describe what you would do if a file edit, shell command, or write is required.",
	"Be concise in final output, but make the real changes.",
].join(" ");

type ScheduleNotifier =
	| { kind: "none" }
	| { kind: "macos" }
	| { kind: "telegram"; botToken: string; chatId: string };

type ScheduleExtensionMode = "builtin" | "magpie";

interface ScheduleRuntimeOptions {
	mode?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: { strategy: "append" | "replace"; text: string };
	notifier: ScheduleNotifier;
	sessionRootDir: string;
	extensionMode: ScheduleExtensionMode;
}

interface ParsedScheduleRequest {
	type: ScheduleType;
	when: string;
	runAt?: string;
	cronExpr?: string;
}

interface ScheduleTaskInput {
	when: string;
	task: string;
	model?: string;
	mode?: string;
	cwd?: string;
	notify?: boolean;
	extensionMode?: ScheduleExtensionMode;
	preferredNotifier?: "telegram" | "macos" | "none";
}

function createScheduleStore(baseDir = resolve(homedir(), ".pi/agent/magpie-schedules")): ScheduleStore {
	return {
		baseDir,
		scriptsDir: resolve(baseDir, "scripts"),
		resultsDir: resolve(baseDir, "results"),
		indexPath: resolve(baseDir, "index.json"),
	};
}

async function ensureStore(store: ScheduleStore) {
	await mkdir(store.scriptsDir, { recursive: true });
	await mkdir(store.resultsDir, { recursive: true });
	await mkdir(dirname(store.indexPath), { recursive: true });
}

function createId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getMagpiePackageDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function getMagpieExtensionPaths(): Promise<string[]> {
	const packageDir = getMagpiePackageDir();
	const requiredExtensions = new Set([
		"subagents/index.ts",
		"modes/index.ts",
		"sessions/index.ts",
		"preferences/index.ts",
		"memory/index.ts",
	]);
	try {
		const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		const extensions = packageJson.pi?.extensions ?? [];
		return extensions
			.filter((value) => typeof value === "string" && requiredExtensions.has(value))
			.map((value) => resolve(packageDir, value));
	} catch {
		return Array.from(requiredExtensions).map((value) => resolve(packageDir, value));
	}
}

function shellEscape(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isCronExpression(value: string) {
	const parts = value.trim().split(/\s+/);
	return parts.length === 5 && parts.every(Boolean);
}

function parseTimeOfDay(input: string | undefined) {
	if (!input?.trim()) return { hour: 9, minute: 0 };
	const parsed = chrono.parseDate(input, new Date(), { forwardDate: true });
	if (!parsed) return undefined;
	return { hour: parsed.getHours(), minute: parsed.getMinutes() };
}

function parseRecurringNaturalWhen(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();

	if (/^(every\s+hour|hourly)$/.test(lower)) return "0 * * * *";
	let match = lower.match(/^every\s+(\d+)\s+minutes?$/);
	if (match) {
		const step = Number(match[1]);
		if (step >= 1 && step <= 59) return `*/${step} * * * *`;
	}
	match = lower.match(/^every\s+(\d+)\s+hours?$/);
	if (match) {
		const step = Number(match[1]);
		if (step >= 1 && step <= 23) return `0 */${step} * * *`;
	}

	match = lower.match(/^(?:every|each)\s+day(?:\s+at\s+(.+))?$/) || lower.match(/^daily(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[1]);
		if (tod) return `${tod.minute} ${tod.hour} * * *`;
	}

	match = lower.match(/^(?:every|each)\s+weekdays?(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[1]);
		if (tod) return `${tod.minute} ${tod.hour} * * 1-5`;
	}

	const dayMap: Record<string, number> = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	};
	match = lower.match(/^(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[2]);
		if (tod) return `${tod.minute} ${tod.hour} * * ${dayMap[match[1]]}`;
	}

	match = lower.match(/^every\s+week(?:\s+on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))?(?:\s+at\s+(.+))?$/);
	if (match) {
		const day = match[1] || "monday";
		const tod = parseTimeOfDay(match[2]);
		if (tod) return `${tod.minute} ${tod.hour} * * ${dayMap[day]}`;
	}

	return undefined;
}

function parseWhenSpec(input: string): ParsedScheduleRequest | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("cron:")) {
		const cronExpr = trimmed.slice(5).trim();
		if (!isCronExpression(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`);
		return { type: "recurring", when: trimmed, cronExpr };
	}
	const recurringCron = parseRecurringNaturalWhen(trimmed);
	if (recurringCron) return { type: "recurring", when: trimmed, cronExpr: recurringCron };
	const relative = trimmed.match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const now = Date.now();
		const delta = unit.startsWith("minute") ? amount * 60_000 : unit.startsWith("hour") ? amount * 3_600_000 : amount * 86_400_000;
		return { type: "one-shot", when: trimmed, runAt: new Date(now + delta).toISOString() };
	}
	const parsed = chrono.parseDate(trimmed, new Date(), { forwardDate: true });
	if (parsed && Number.isFinite(parsed.getTime())) return { type: "one-shot", when: trimmed, runAt: parsed.toISOString() };
	const legacy = new Date(trimmed);
	if (Number.isFinite(legacy.getTime())) return { type: "one-shot", when: trimmed, runAt: legacy.toISOString() };
	return undefined;
}

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

async function resolveCommandPath(command: string): Promise<string | undefined> {
	try {
		const result = await execFileAsync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
		const value = result.stdout.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
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

async function writeIndex(store: ScheduleStore, entries: ScheduleEntry[]) {
	await ensureStore(store);
	await writeFile(store.indexPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
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

function createPiCommand(entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions, extensionPaths: string[]): string {
	const args = [
		shellEscape(piCommand),
		"--print",
		`--session-dir \"$SESSION_DIR\"`,
	];
	if (runtime.extensionMode === "magpie") {
		args.push("--no-extensions");
		for (const extensionPath of extensionPaths) args.push(`--extension ${shellEscape(extensionPath)}`);
	} else {
		args.push(`--tools ${shellEscape(SCHEDULE_BUILTIN_TOOLS.join(","))}`);
	}
	if (runtime.model) args.push(`--model ${shellEscape(runtime.model)}`);
	if (runtime.thinkingLevel) args.push(`--thinking ${shellEscape(runtime.thinkingLevel)}`);
	if (runtime.systemPrompt?.text) {
		const flag = runtime.systemPrompt.strategy === "replace" ? "--system-prompt" : "--append-system-prompt";
		args.push(`${flag} ${shellEscape(runtime.systemPrompt.text)}`);
	}
	args.push(shellEscape(entry.task));
	return args.join(" ");
}

function createNotificationScript(entry: ScheduleEntry, runtime: ScheduleRuntimeOptions): string {
	if (!entry.notify || runtime.notifier.kind === "none") return "";
	if (runtime.notifier.kind === "macos") {
		return `
if command -v osascript >/dev/null 2>&1; then
  SUMMARY="$(head -c 200 "$RESULT_PATH" 2>/dev/null | tr '\n' ' ' | tr '\r' ' ' || true)"
  MAGPIE_NOTIFY_TITLE=${shellEscape("Magpie")} \\
  MAGPIE_NOTIFY_SUBTITLE=${shellEscape(`Scheduled task ${entry.id} complete`)} \\
  MAGPIE_NOTIFY_MESSAGE="$SUMMARY" \\
  osascript <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run
  set ttl to system attribute "MAGPIE_NOTIFY_TITLE"
  set sub to system attribute "MAGPIE_NOTIFY_SUBTITLE"
  set msg to system attribute "MAGPIE_NOTIFY_MESSAGE"
  display notification msg with title ttl subtitle sub
end run
APPLESCRIPT
fi
`;
	}
	return `
if command -v curl >/dev/null 2>&1; then
  TELEGRAM_HEADER=${shellEscape(`Magpie schedule ${entry.id} completed ($EXIT_CODE)\nTask: ${entry.task}\nCwd: ${entry.cwd}\n\n`)}
  TELEGRAM_BODY="$(head -c 3500 "$RESULT_PATH" 2>/dev/null || true)"
  TELEGRAM_TEXT="\${TELEGRAM_HEADER}\${TELEGRAM_BODY}"
  curl -sS -X POST ${shellEscape(`https://api.telegram.org/bot${runtime.notifier.botToken}/sendMessage`)} \\
    --data-urlencode ${shellEscape(`chat_id=${runtime.notifier.chatId}`)} \\
    --data-urlencode "text=$TELEGRAM_TEXT" \\
    --data-urlencode "parse_mode=HTML" \\
    >/dev/null 2>&1 || true
fi
`;
}

function createIndexUpdateScript(store: ScheduleStore, entry: ScheduleEntry) {
	return `
${shellEscape(process.execPath)} <<'NODE' >/dev/null 2>&1 || true
const fs = require('node:fs');
const path = ${JSON.stringify(store.indexPath)};
const entryId = ${JSON.stringify(entry.id)};
const run = {
  startedAt: process.env.MAGPIE_RUN_STARTED_AT,
  endedAt: process.env.MAGPIE_RUN_ENDED_AT,
  exitCode: Number(process.env.MAGPIE_RUN_EXIT_CODE),
  resultPath: process.env.MAGPIE_RUN_RESULT_PATH,
  statePath: process.env.MAGPIE_RUN_STATE_PATH,
  sessionDir: process.env.MAGPIE_RUN_SESSION_DIR,
};
try {
  const entries = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) process.exit(0);
  const idx = entries.findIndex((item) => item && item.id === entryId);
  if (idx < 0) process.exit(0);
  const current = entries[idx] || {};
  const runs = Array.isArray(current.runs) ? current.runs : [];
  runs.push(run);
  current.runs = runs;
  current.resultPath = run.resultPath;
  current.statePath = run.statePath;
  current.sessionDir = run.sessionDir;
  entries[idx] = current;
  fs.writeFileSync(path, JSON.stringify(entries, null, 2) + '\n', 'utf8');
} catch {}
NODE
`;
}

function createRunnerScript(store: ScheduleStore, entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions, extensionPaths: string[]): string {
	const runtimeNodeDir = dirname(process.execPath);
	const inheritedPath = process.env.PATH || "";
	const runnerPath = [runtimeNodeDir, inheritedPath, ...COMMON_PATHS].filter(Boolean).join(":");
	const cleanup = entry.type === "one-shot" && entry.backend === "cron_fallback" && entry.cronId
		? `
if command -v crontab >/dev/null 2>&1; then
  TMP_CRON="$(mktemp)"
  (crontab -l 2>/dev/null || true) | grep -v ${shellEscape(`# ${entry.cronId}`)} > "$TMP_CRON"
  crontab "$TMP_CRON" || true
  rm -f "$TMP_CRON"
fi
`
		: "";
	const piInvocation = createPiCommand(entry, piCommand, runtime, extensionPaths);
	const notify = createNotificationScript(entry, runtime);
	const updateIndex = createIndexUpdateScript(store, entry);
	return `#!/usr/bin/env bash
set -euo pipefail
export PATH=${shellEscape(runnerPath)}
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
RESULT_DIR=${shellEscape(resolve(store.resultsDir, entry.id))}
SESSION_ROOT=${shellEscape(runtime.sessionRootDir)}
RESULT_PATH="$RESULT_DIR/$RUN_STAMP.result.md"
STATE_PATH="$RESULT_DIR/$RUN_STAMP.state"
SESSION_DIR="$SESSION_ROOT/$RUN_STAMP"
mkdir -p "$RESULT_DIR" "$SESSION_DIR"
printf 'startedAt=%s\nresultPath=%s\nsessionDir=%s\n' "$STARTED_AT" "$RESULT_PATH" "$SESSION_DIR" > "$STATE_PATH"
${cleanup}
EXIT_CODE=0
if ! cd ${shellEscape(entry.cwd)}; then
  printf 'Scheduled task failed: cwd does not exist: %s\n' ${shellEscape(entry.cwd)} > "$RESULT_PATH"
  EXIT_CODE=1
else
  set +e
  ${piInvocation} > "$RESULT_PATH" 2>&1
  EXIT_CODE=$?
  set -e
fi
ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'startedAt=%s\nendedAt=%s\nexitCode=%s\nresultPath=%s\nsessionDir=%s\n' "$STARTED_AT" "$ENDED_AT" "$EXIT_CODE" "$RESULT_PATH" "$SESSION_DIR" > "$STATE_PATH"
export MAGPIE_RUN_STARTED_AT="$STARTED_AT"
export MAGPIE_RUN_ENDED_AT="$ENDED_AT"
export MAGPIE_RUN_EXIT_CODE="$EXIT_CODE"
export MAGPIE_RUN_RESULT_PATH="$RESULT_PATH"
export MAGPIE_RUN_STATE_PATH="$STATE_PATH"
export MAGPIE_RUN_SESSION_DIR="$SESSION_DIR"
${updateIndex}
${notify}
exit "$EXIT_CODE"
`;
}

async function chooseBackend(type: ScheduleType): Promise<ScheduleBackend> {
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

async function scheduleEntry(entry: ScheduleEntry): Promise<ScheduleEntry> {
	const backend = await chooseBackend(entry.type);
	if (entry.type === "one-shot" && backend === "at") {
		const atTime = formatAtTimestamp(new Date(entry.runAt!));
		const result = await new Promise<string>((resolve, reject) => {
			const child = execFile("at", ["-t", atTime], (error, stdout, stderr) => {
				if (error) reject(new Error(stderr || stdout || error.message));
				else resolve(`${stdout}${stderr}`);
			});
			child.stdin?.end(`${entry.scriptPath}\n`, "utf8");
		});
		const jobId = result.match(/job\s+(\d+)/i)?.[1];
		return { ...entry, backend, atJobId: jobId };
	}
	const cronId = `magpie-schedule-${entry.id}`;
	const cronLine = entry.type === "recurring"
		? `${entry.cronExpr} /bin/bash ${shellEscape(entry.scriptPath)} # ${cronId}`
		: `${new Date(entry.runAt!).getMinutes()} ${new Date(entry.runAt!).getHours()} ${new Date(entry.runAt!).getDate()} ${new Date(entry.runAt!).getMonth() + 1} * /bin/bash ${shellEscape(entry.scriptPath)} # ${cronId}`;
	await installCronLine(cronId, cronLine);
	return { ...entry, backend, cronId };
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

function describeEntryStatus(entry: ScheduleEntry) {
	if (entry.cancelledAt) return `cancelled at ${entry.cancelledAt}`;
	const lastRun = entry.runs.at(-1);
	if (lastRun?.endedAt) return `completed (${lastRun.exitCode ?? 0}) at ${lastRun.endedAt}`;
	if (lastRun?.startedAt) return `running since ${lastRun.startedAt}`;
	if (entry.type === "recurring") return `recurring (${entry.cronExpr})`;
	if (entry.runAt && Date.parse(entry.runAt) < Date.now()) return `missed/unknown after ${entry.runAt}`;
	return entry.runAt ? `scheduled for ${entry.runAt}` : `scheduled (${entry.when})`;
}

function formatEntry(entry: ScheduleEntry) {
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

function resolveScheduleNotifier(config: MagpieConfig, auth: MagpieAuthConfig, shouldNotify: boolean, preferred?: "telegram" | "macos" | "none"): ScheduleNotifier {
	if (!shouldNotify) return { kind: "none" };
	const explicit = preferred ?? config.schedule?.notifier;
	const telegramConfigured = Boolean(config.schedule?.telegram?.chatId?.trim() && (config.schedule?.telegram?.botToken?.trim() || auth.telegram?.botToken?.trim()));
	const kind = explicit ?? (process.platform === "darwin" ? "macos" : telegramConfigured ? "telegram" : "none");
	if (kind === "none") return { kind: "none" };
	if (kind === "macos") return { kind: "macos" };
	const botToken = config.schedule?.telegram?.botToken?.trim() || auth.telegram?.botToken?.trim();
	const chatId = config.schedule?.telegram?.chatId?.trim();
	if (!botToken || !chatId) throw new Error("schedule notifier is set to telegram, but schedule.telegram.chatId and a Telegram bot token are not fully configured.");
	return { kind: "telegram", botToken, chatId };
}

async function resolveScheduleRuntimeOptions(
	ctx: ExtensionContext,
	store: ScheduleStore,
	id: string,
	input: ScheduleTaskInput,
) {
	const cwd = resolve(input.cwd?.trim() || ctx.cwd);
	const [config, auth] = await Promise.all([loadConfig(cwd), loadAuthConfig(cwd)]);
	const modeName = input.mode?.trim() || getActiveModeName(ctx, config);
	const mode = getMode(config, modeName) ?? getMode(config, "smart");
	const baseDir = getConfigBaseDir(getActiveConfigScope(cwd), cwd);
	const modePromptText = mode?.prompt ? await resolvePromptText(baseDir, mode.prompt) : undefined;
	const promptParts = [modePromptText?.trim(), SCHEDULE_BACKGROUND_PROMPT].filter(Boolean) as string[];
	return {
		cwd,
		mode: mode?.name ?? modeName,
		model: input.model ?? mode?.model,
		thinkingLevel: mode?.thinkingLevel,
		systemPrompt: promptParts.length === 0 ? undefined : {
			strategy: mode?.prompt?.strategy ?? "append",
			text: promptParts.join("\n\n"),
		},
		notifier: resolveScheduleNotifier(config, auth, input.notify !== false, input.preferredNotifier),
		sessionRootDir: resolve(store.baseDir, "sessions", id),
		extensionMode: input.extensionMode ?? "builtin",
	} satisfies ScheduleRuntimeOptions & { cwd: string };
}

function formatNotificationSummary(notifier: ScheduleNotifier, enabled: boolean) {
	if (!enabled || notifier.kind === "none") return "Notification disabled.";
	if (notifier.kind === "macos") return "Notification will be sent via macOS when complete.";
	return "Notification will be sent via Telegram when complete.";
}

export async function ensureAutodreamScheduled(
	ctx: ExtensionContext,
	input: { enabled: boolean; schedule?: string; task: string; cwd?: string },
): Promise<ScheduleEntry | undefined> {
	const store = createScheduleStore();
	const entries = await readIndex(store);
	const targetCwd = resolve(input.cwd?.trim() || ctx.cwd);
	const activeEntries = entries.filter((entry) => !entry.cancelledAt && entry.task === input.task && entry.cwd === targetCwd);
	if (!input.enabled || !input.schedule?.trim()) {
		for (const entry of activeEntries) {
			await cancelScheduledEntry(entry);
			entry.cancelledAt = new Date().toISOString();
		}
		if (activeEntries.length > 0) await writeIndex(store, entries);
		return undefined;
	}
	const cronWhen = input.schedule.trim().startsWith("cron:") ? input.schedule.trim() : `cron:${input.schedule.trim()}`;
	const existing = activeEntries.find((entry) => entry.when === cronWhen);
		if (existing) return existing;
	for (const entry of activeEntries) {
		await cancelScheduledEntry(entry);
		entry.cancelledAt = new Date().toISOString();
	}
	if (activeEntries.length > 0) await writeIndex(store, entries);
	const scheduled = await scheduleTask(ctx, {
		when: cronWhen,
		task: input.task,
		cwd: targetCwd,
		notify: true,
		extensionMode: "magpie",
	});
	return scheduled.entry;
}

export async function scheduleTask(ctx: ExtensionContext, input: ScheduleTaskInput) {
	const store = createScheduleStore();
	const parsed = parseWhenSpec(input.when);
	if (!parsed) throw new Error(`Could not parse time: ${input.when}`);
	if (parsed.type === "one-shot" && (!parsed.runAt || Date.parse(parsed.runAt) <= Date.now())) throw new Error("Scheduled time must be in the future.");
	const piCommand = await resolveCommandPath("pi");
	if (!piCommand) throw new Error("Could not find 'pi' on PATH for scheduled execution.");
	const entries = await readIndex(store);
	const id = createId();
	await ensureStore(store);
	const runtime = await resolveScheduleRuntimeOptions(ctx, store, id, input);
	const extensionPaths = runtime.extensionMode === "magpie" ? await getMagpieExtensionPaths() : [];
	const scriptPath = resolve(store.scriptsDir, `${id}.sh`);
	let entry: ScheduleEntry = {
		id,
		type: parsed.type,
		cwd: runtime.cwd,
		task: input.task,
		model: runtime.model,
		mode: runtime.mode,
		when: input.when,
		runAt: parsed.runAt,
		cronExpr: parsed.cronExpr,
		backend: "at",
		scriptPath,
		resultPath: undefined,
		statePath: undefined,
		sessionDir: runtime.sessionRootDir,
		createdAt: new Date().toISOString(),
		notify: input.notify !== false,
		runs: [],
	};
	entry = { ...entry, backend: await chooseBackend(entry.type) };
	await writeFile(scriptPath, createRunnerScript(store, entry, piCommand, runtime, extensionPaths), "utf8");
	await chmod(scriptPath, 0o755);
	entry = await scheduleEntry(entry);
	entries.push(entry);
	await writeIndex(store, entries);
	return { entry, notificationSummary: formatNotificationSummary(runtime.notifier, entry.notify) };
}

function renderScheduleInterpretProgress(partialOutput: string, toolCalls: Array<{ name: string }>) {
	const lines = ["⏳ schedule: interpreting request"];
	for (const item of toolCalls.slice(-6)) lines.push(`  → ${item.name}`);
	if (partialOutput.trim()) lines.push(`  ${partialOutput.trim().split("\n")[0]}`);
	return lines;
}

function parseInterpretedScheduleOutput(output: string) {
	const parsed = JSON.parse(output.trim()) as { when?: string; task?: string; mode?: string; cwd?: string; error?: string };
	if (parsed.error?.trim()) throw new Error(parsed.error.trim());
	if (!parsed.when?.trim() || !parsed.task?.trim()) throw new Error("Schedule interpretation did not return both when and task.");
	return {
		when: parsed.when.trim(),
		task: parsed.task.trim(),
		mode: parsed.mode?.trim(),
		cwd: parsed.cwd?.trim(),
	};
}

function formatLogs(entry: ScheduleEntry) {
	const runs = entry.type === "recurring" ? entry.runs.slice(-10) : entry.runs.slice(-1);
	if (runs.length === 0) return `No result yet for ${entry.id}\nStatus: ${describeEntryStatus(entry)}\nBackend: ${entry.backend}`;
	return runs.map((run, index) => [
		entry.type === "recurring" ? `Run ${entry.runs.length - runs.length + index + 1}` : `Run`,
		`startedAt: ${run.startedAt}`,
		run.endedAt ? `endedAt: ${run.endedAt}` : undefined,
		typeof run.exitCode === "number" ? `exitCode: ${run.exitCode}` : undefined,
		run.sessionDir ? `sessionDir: ${run.sessionDir}` : undefined,
		"",
		existsSync(run.resultPath) ? undefined : `(missing result file: ${run.resultPath})`,
	].filter(Boolean).join("\n") + (existsSync(run.resultPath) ? `\n${requireResultPlaceholder(run.resultPath)}` : "")).join("\n\n---\n\n");
}

function requireResultPlaceholder(path: string) {
	return `@@RESULT:${path}`;
}

async function expandLogResultPlaceholders(text: string) {
	const matches = [...text.matchAll(/@@RESULT:([^\n]+)/g)];
	let rendered = text;
	for (const match of matches) {
		const path = match[1];
		const body = existsSync(path) ? await readFile(path, "utf8") : `(missing result file: ${path})`;
		rendered = rendered.replace(match[0], body);
	}
	return rendered;
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});
	pi.events.emit("magpie:subagent-core:get", (api: unknown) => {
		subagentCore = api as SubagentCoreAPI;
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description: "Schedule a task to run in the background at a future time. Works even if pi is not currently running.",
		parameters: Type.Object({
			when: Type.String({ description: "When to run. Accepts: 'in N minutes/hours/days', ISO 8601/natural language datetime, or cron expression prefixed with 'cron:'" }),
			task: Type.String({ description: "The prompt to give to pi when it runs." }),
			model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
			mode: Type.Optional(Type.String({ description: "Optional Magpie mode to use." })),
			cwd: Type.Optional(Type.String({ description: "Optional working directory. Defaults to current cwd." })),
			notify: Type.Optional(Type.Boolean({ description: "Whether to notify on completion. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { entry, notificationSummary } = await scheduleTask(ctx, params);
				const timePart = entry.type === "recurring" ? `cron ${entry.cronExpr}` : entry.runAt;
				return {
					content: [{ type: "text", text: `Scheduled: ${JSON.stringify(entry.task)} for ${timePart}. ${notificationSummary}` }],
					details: { entry },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("schedule", {
		description: "Schedule tasks: /schedule <time> <task>, /schedule cron <expr> <task>, /schedule list, /schedule logs <id>, /schedule cancel <id>",
		handler: async (args, ctx) => {
			const raw = args?.trim() || "";
			const store = createScheduleStore();
			const entries = await readIndex(store);

			if (!raw) {
				ctx.ui.notify("Usage: /schedule <time> <task> | /schedule cron <expr> <task> | /schedule list | /schedule logs <id> | /schedule cancel <id>", "info");
				return;
			}

			if (raw === "list") {
				ctx.ui.notify(entries.length ? entries.map(formatEntry).join("\n\n") : "No scheduled tasks.", "info");
				return;
			}

			if (raw.startsWith("logs ")) {
				const id = raw.slice(5).trim();
				const entry = entries.find((item) => item.id === id);
				if (!entry) {
					ctx.ui.notify(`No scheduled task found: ${id}`, "error");
					return;
				}
				ctx.ui.notify(await expandLogResultPlaceholders(formatLogs(entry)), "info");
				return;
			}

			if (raw.startsWith("cancel ")) {
				const id = raw.slice(7).trim();
				const entry = entries.find((item) => item.id === id);
				if (!entry) {
					ctx.ui.notify(`No scheduled task found: ${id}`, "error");
					return;
				}
				await cancelScheduledEntry(entry);
				entry.cancelledAt = new Date().toISOString();
				await writeIndex(store, entries);
				ctx.ui.notify(`Cancelled schedule ${id}`, "info");
				return;
			}

			const cronMatch = raw.match(/^cron\s+([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)\s+([\s\S]+)$/i);
			if (cronMatch) {
				try {
					const { entry, notificationSummary } = await scheduleTask(ctx, { when: `cron:${cronMatch[1].trim()}`, task: cronMatch[2].trim() });
					ctx.ui.notify(`Scheduled ${entry.id} with cron ${entry.cronExpr}. ${notificationSummary}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			const explicit = raw.match(/^(cron:[^\s]+(?:\s+[^\s]+){4}|in\s+\d+\s+(?:minute|minutes|hour|hours|day|days)|\d{4}-\d{2}-\d{2}[^\s]*)\s+([\s\S]+)$/i);
			if (explicit) {
				try {
					const { entry, notificationSummary } = await scheduleTask(ctx, { when: explicit[1].trim(), task: explicit[2].trim() });
					ctx.ui.notify(`Scheduled ${entry.id}${entry.type === "recurring" ? ` with cron ${entry.cronExpr}` : ` for ${entry.runAt}`}. ${notificationSummary}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			if (!subagentCore) {
				ctx.ui.notify("Could not parse schedule request, and subagent core is unavailable for natural-language interpretation.", "error");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const scheduleModel = resolveSubagentModelRef(config.subagents.schedule);
			const widgetKey = `magpie-schedule-${Date.now()}`;
			ctx.ui.setWidget(widgetKey, ["⏳ schedule: interpreting request"], { placement: "aboveEditor" });
			void subagentCore.runSubagent(ctx, config, {
				role: "custom",
				label: "schedule-interpret",
				task: [
					"Interpret this scheduling request and return exactly one JSON object.",
					"Required fields: when (string), task (string).",
					"Optional fields: mode (string), cwd (string).",
					"If the user asks for recurring behavior (e.g. every day/each day/weekly), you MUST return when as a cron-prefixed string like 'cron:0 9 * * *'.",
					"Do not return natural-language recurring phrases in when for recurring tasks.",
					"Examples:",
					"- Request: 'every day at 9 summarize unread mail' -> {\"when\":\"cron:0 9 * * *\",\"task\":\"summarize unread mail\"}",
					"- Request: 'in 30 minutes summarize logs' -> {\"when\":\"in 30 minutes\",\"task\":\"summarize logs\"}",
					`User request: ${raw}`,
				].join("\n\n"),
				context: [
					"You are running as a background /schedule interpretation subagent.",
					"Return only valid JSON and do not ask follow-up questions.",
				].join("\n"),
				model: scheduleModel?.model,
				thinkingLevel: scheduleModel?.thinkingLevel,
				tools: "readonly",
				timeout: 120000,
			}, undefined, (progress) => {
				ctx.ui.setWidget(widgetKey, renderScheduleInterpretProgress(progress.partialOutput, progress.toolCalls), { placement: "aboveEditor" });
			}).then(async (result) => {
				ctx.ui.setWidget(widgetKey, undefined);
				if (result.exitCode !== 0 || !result.output.trim()) {
					ctx.ui.notify(result.errorMessage || "Schedule interpretation failed.", "error");
					return;
				}
				try {
					const interpreted = parseInterpretedScheduleOutput(result.output);
					const { entry, notificationSummary } = await scheduleTask(ctx, interpreted);
					ctx.ui.notify(`Scheduled ${entry.id}${entry.type === "recurring" ? ` with cron ${entry.cronExpr}` : ` for ${entry.runAt}`}. ${notificationSummary}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}).catch((error) => {
				ctx.ui.setWidget(widgetKey, undefined);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			});
			ctx.ui.notify("Interpreting schedule request in background…", "info");
		},
	});
}
