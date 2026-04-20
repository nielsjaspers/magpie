import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { getActiveModeName } from "../pa/shared/mode.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import type { MagpieAuthConfig, MagpieConfig, ThinkingLevel } from "../config/types.js";
import type { ScheduleBackend, ScheduleEntry, ScheduleRunState, ScheduleStore } from "./types.js";

const execFileAsync = promisify(execFile);
const CRON_BEGIN = "# MAGPIE-SCHEDULE-BEGIN";
const CRON_END = "# MAGPIE-SCHEDULE-END";
const SCHEDULE_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
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

interface ScheduleRuntimeOptions {
	mode?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: { strategy: "append" | "replace"; text: string };
	notifier: ScheduleNotifier;
	sessionDir: string;
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

async function readIndex(store: ScheduleStore): Promise<ScheduleEntry[]> {
	await ensureStore(store);
	if (!existsSync(store.indexPath)) return [];
	try {
		return JSON.parse(await readFile(store.indexPath, "utf8")) as ScheduleEntry[];
	} catch {
		return [];
	}
}

async function writeIndex(store: ScheduleStore, entries: ScheduleEntry[]) {
	await ensureStore(store);
	await writeFile(store.indexPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

function createId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function shellEscape(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseWhenSpec(input: string): Date | undefined {
	const relative = input.trim().match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const now = Date.now();
		const delta = unit.startsWith("minute") ? amount * 60_000 : unit.startsWith("hour") ? amount * 3_600_000 : amount * 86_400_000;
		return new Date(now + delta);
	}
	const parsed = new Date(input);
	if (Number.isFinite(parsed.getTime())) return parsed;
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

function cronSpecForDate(date: Date): string {
	return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
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

function createPiCommand(entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions): string {
	const args = [
		shellEscape(piCommand),
		"--print",
		`--session-dir ${shellEscape(runtime.sessionDir)}`,
		`--tools ${shellEscape(SCHEDULE_BUILTIN_TOOLS.join(","))}`,
	];
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
  MAGPIE_NOTIFY_TITLE=${shellEscape(`Magpie schedule ${entry.id}`)} \
  MAGPIE_NOTIFY_SUBTITLE="Completed ($EXIT_CODE)" \
  MAGPIE_NOTIFY_MESSAGE="$SUMMARY" \
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
  TELEGRAM_HEADER=${shellEscape(`Magpie schedule ${entry.id} completed ($EXIT_CODE)
Task: ${entry.task}
Cwd: ${entry.cwd}

`)}
  TELEGRAM_BODY="$(head -c 3500 "$RESULT_PATH" 2>/dev/null || true)"
  TELEGRAM_TEXT="\${TELEGRAM_HEADER}\${TELEGRAM_BODY}"
  curl -sS -X POST ${shellEscape(`https://api.telegram.org/bot${runtime.notifier.botToken}/sendMessage`)} \
    --data-urlencode ${shellEscape(`chat_id=${runtime.notifier.chatId}`)} \
    --data-urlencode "text=$TELEGRAM_TEXT" \
    >/dev/null 2>&1 || true
fi
`;
}

function createRunnerScript(entry: ScheduleEntry, piCommand: string, runtime: ScheduleRuntimeOptions): string {
	const runtimeNodeDir = dirname(process.execPath);
	const inheritedPath = process.env.PATH || "";
	const runnerPath = [runtimeNodeDir, inheritedPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
		.filter(Boolean)
		.join(":");
	const cleanup = entry.backend === "cron_fallback" && entry.cronId
		? `
if command -v crontab >/dev/null 2>&1; then
  TMP_CRON="$(mktemp)"
  (crontab -l 2>/dev/null || true) | grep -v ${shellEscape(`# ${entry.cronId}`)} > "$TMP_CRON"
  crontab "$TMP_CRON" || true
  rm -f "$TMP_CRON"
fi
`
		: "";
	const piInvocation = createPiCommand(entry, piCommand, runtime);
	const notify = createNotificationScript(entry, runtime);
	return `#!/usr/bin/env bash
set -euo pipefail
export PATH=${shellEscape(runnerPath)}
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATE_PATH=${shellEscape(entry.statePath)}
RESULT_PATH=${shellEscape(entry.resultPath)}
SESSION_DIR=${shellEscape(runtime.sessionDir)}
mkdir -p "$(dirname "$STATE_PATH")" "$(dirname "$RESULT_PATH")" "$SESSION_DIR"
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
${notify}
exit "$EXIT_CODE"
`;
}

async function chooseBackend(): Promise<ScheduleBackend> {
	const hasCron = await commandExists("crontab");
	if (process.platform === "darwin" && hasCron) return "cron_fallback";
	if (await commandExists("at")) return "at";
	if (hasCron) return "cron_fallback";
	throw new Error("Neither 'at' nor 'crontab' is available on this system.");
}

async function scheduleOneShot(entry: ScheduleEntry): Promise<ScheduleEntry> {
	const backend = await chooseBackend();
	if (backend === "at") {
		const atTime = formatAtTimestamp(new Date(entry.runAt));
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
	const cronLine = `${cronSpecForDate(new Date(entry.runAt))} /bin/bash ${shellEscape(entry.scriptPath)} # ${cronId}`;
	await installCronLine(cronId, cronLine);
	return { ...entry, backend, cronId };
}

async function cancelScheduledEntry(entry: ScheduleEntry) {
	if (entry.atJobId && await commandExists("atrm")) {
		try { await execFileAsync("atrm", [entry.atJobId]); } catch {}
	}
	if (entry.cronId) {
		try { await removeCronLine(entry.cronId); } catch {}
	}
}

async function readRunState(path: string): Promise<ScheduleRunState | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		const raw = await readFile(path, "utf8");
		const values = Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map((line) => {
			const idx = line.indexOf("=");
			return [line.slice(0, idx), line.slice(idx + 1)];
		}));
		return {
			startedAt: values.startedAt,
			endedAt: values.endedAt,
			exitCode: values.exitCode ? Number(values.exitCode) : undefined,
			resultPath: values.resultPath || path.replace(/\.state$/, ".result.md"),
			sessionDir: values.sessionDir,
		};
	} catch {
		return undefined;
	}
}

function describeEntryStatus(entry: ScheduleEntry, state?: ScheduleRunState) {
	if (entry.cancelledAt) return `cancelled at ${entry.cancelledAt}`;
	if (state?.endedAt) return `completed (${state.exitCode ?? 0}) at ${state.endedAt}`;
	if (state?.startedAt) return `running since ${state.startedAt}`;
	if (Date.parse(entry.runAt) < Date.now()) return `missed/unknown after ${entry.runAt}`;
	return `scheduled for ${entry.runAt}`;
}

function formatEntry(entry: ScheduleEntry, state?: ScheduleRunState) {
	return [
		`${entry.id} · ${describeEntryStatus(entry, state)}`,
		`- task: ${entry.task}`,
		`- backend: ${entry.backend}`,
		`- cwd: ${entry.cwd}`,
		entry.sessionDir ? `- sessionDir: ${entry.sessionDir}` : undefined,
	].filter(Boolean).join("\n");
}

function resolveScheduleNotifier(config: MagpieConfig, auth: MagpieAuthConfig, shouldNotify: boolean): ScheduleNotifier {
	if (!shouldNotify) return { kind: "none" };
	const kind = config.schedule?.notifier ?? "none";
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
	input: { model?: string; notify?: boolean },
) {
	const [config, auth] = await Promise.all([loadConfig(ctx.cwd), loadAuthConfig(ctx.cwd)]);
	const activeMode = getActiveModeName(ctx, config);
	const mode = getMode(config, activeMode) ?? getMode(config, "smart");
	const baseDir = getConfigBaseDir(getActiveConfigScope(ctx.cwd), ctx.cwd);
	const modePromptText = mode?.prompt ? await resolvePromptText(baseDir, mode.prompt) : undefined;
	const promptParts = [modePromptText?.trim(), SCHEDULE_BACKGROUND_PROMPT].filter(Boolean) as string[];
	return {
		mode: mode?.name ?? activeMode,
		model: input.model ?? mode?.model,
		thinkingLevel: mode?.thinkingLevel,
		systemPrompt: promptParts.length === 0 ? undefined : {
			strategy: mode?.prompt?.strategy ?? "append",
			text: promptParts.join("\n\n"),
		},
		notifier: resolveScheduleNotifier(config, auth, input.notify !== false),
		sessionDir: resolve(store.baseDir, "sessions", id),
	} satisfies ScheduleRuntimeOptions;
}

async function scheduleTask(ctx: ExtensionContext, input: { when: string; task: string; model?: string; notify?: boolean }) {
	const store = createScheduleStore();
	const runAt = parseWhenSpec(input.when);
	if (!runAt) throw new Error(`Could not parse time: ${input.when}`);
	if (runAt.getTime() <= Date.now()) throw new Error("Scheduled time must be in the future.");
	const piCommand = await resolveCommandPath("pi");
	if (!piCommand) throw new Error("Could not find 'pi' on PATH for scheduled execution.");
	const entries = await readIndex(store);
	const id = createId();
	await ensureStore(store);
	const runtime = await resolveScheduleRuntimeOptions(ctx, store, id, input);
	const scriptPath = resolve(store.scriptsDir, `${id}.sh`);
	const resultPath = resolve(store.resultsDir, `${id}.result.md`);
	const statePath = resolve(store.resultsDir, `${id}.state`);
	let entry: ScheduleEntry = {
		id,
		type: "one-shot",
		cwd: ctx.cwd,
		task: input.task,
		model: runtime.model,
		mode: runtime.mode,
		when: input.when,
		runAt: runAt.toISOString(),
		backend: "at",
		scriptPath,
		resultPath,
		statePath,
		sessionDir: runtime.sessionDir,
		createdAt: new Date().toISOString(),
		notify: input.notify !== false,
	};
	entry = { ...entry, backend: await chooseBackend() };
	await writeFile(scriptPath, createRunnerScript(entry, piCommand, runtime), "utf8");
	await chmod(scriptPath, 0o755);
	entry = await scheduleOneShot(entry);
	entries.push(entry);
	await writeIndex(store, entries);
	return entry;
}

function renderScheduleInterpretProgress(partialOutput: string, toolCalls: Array<{ name: string }>) {
	const lines = ["⏳ schedule: interpreting request"];
	for (const item of toolCalls.slice(-6)) lines.push(`  → ${item.name}`);
	if (partialOutput.trim()) lines.push(`  ${partialOutput.trim().split("\n")[0]}`);
	return lines;
}

function parseInterpretedScheduleOutput(output: string) {
	const parsed = JSON.parse(output.trim()) as { when?: string; task?: string; error?: string };
	if (parsed.error?.trim()) throw new Error(parsed.error.trim());
	if (!parsed.when?.trim() || !parsed.task?.trim()) throw new Error("Schedule interpretation did not return both when and task.");
	return { when: parsed.when.trim(), task: parsed.task.trim() };
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
		description: "Schedule a one-shot task to run later via system scheduler (at first, cron fallback).",
		parameters: Type.Object({
			when: Type.String({ description: "When to run, e.g. 'in 10 minutes' or an ISO datetime." }),
			task: Type.String({ description: "Task prompt to run later." }),
			model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
			notify: Type.Optional(Type.Boolean({ description: "Whether to notify on completion. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const entry = await scheduleTask(ctx, { when: params.when, task: params.task, model: params.model, notify: params.notify });
				return {
					content: [{ type: "text", text: `Scheduled ${entry.id} for ${entry.runAt} using ${entry.backend}.` }],
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
		description: "Schedule one-shot tasks: /schedule <time> <task>, /schedule list, /schedule logs <id>, /schedule cancel <id>",
		handler: async (args, ctx) => {
			const raw = args?.trim() || "";
			const store = createScheduleStore();
			const entries = await readIndex(store);

			if (!raw) {
				ctx.ui.notify("Usage: /schedule <time> <task> | /schedule list | /schedule logs <id> | /schedule cancel <id>", "info");
				return;
			}

			if (raw === "list") {
				const lines = await Promise.all(entries.map(async (entry) => formatEntry(entry, await readRunState(entry.statePath))));
				ctx.ui.notify(lines.length ? lines.join("\n\n") : "No scheduled tasks.", "info");
				return;
			}

			if (raw.startsWith("logs ")) {
				const id = raw.slice(5).trim();
				const entry = entries.find((item) => item.id === id);
				if (!entry) {
					ctx.ui.notify(`No scheduled task found: ${id}`, "error");
					return;
				}
				const state = await readRunState(entry.statePath);
				if (!state?.resultPath || !existsSync(state.resultPath)) {
					ctx.ui.notify(`No result yet for ${id}\nStatus: ${describeEntryStatus(entry, state)}\nBackend: ${entry.backend}`, "warning");
					return;
				}
				ctx.ui.notify(await readFile(state.resultPath, "utf8"), "info");
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

			const explicit = raw.match(/^(in\s+\d+\s+(?:minute|minutes|hour|hours|day|days)|\d{4}-\d{2}-\d{2}[^\s]*)\s+([\s\S]+)$/i);
			if (explicit) {
				try {
					const entry = await scheduleTask(ctx, { when: explicit[1].trim(), task: explicit[2].trim() });
					ctx.ui.notify(`Scheduled ${entry.id} for ${entry.runAt} using ${entry.backend}`, "info");
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
					"Only support one-shot scheduling for now.",
					"If the request sounds recurring (for example 'every 2 hours'), return JSON with an error field explaining that recurring schedules are not supported yet.",
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
					const entry = await scheduleTask(ctx, interpreted);
					ctx.ui.notify(`Scheduled ${entry.id} for ${entry.runAt} using ${entry.backend}`, "info");
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
