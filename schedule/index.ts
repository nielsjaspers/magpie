import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	getActiveConfigScope,
	getConfigBaseDir,
	getMode,
	loadAuthConfig,
	loadConfig,
	resolvePromptText,
	resolveSubagentModelRef,
} from "../config/config.js";
import type { MagpieAuthConfig, MagpieConfig } from "../config/types.js";
import { getActiveModeName } from "../pa/shared/mode.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { expandLogResultPlaceholders, formatEntry, formatLogs } from "./format.js";
import { parseWhenSpec } from "./parser.js";
import { createRunnerScript, shellEscape } from "./runner-script.js";
import { createScheduleStore, ensureStore, readIndex, writeIndex } from "./store.js";
import type {
	ScheduleBackend,
	ScheduleExtensionMode,
	ScheduleEntry,
	ScheduleNotifier,
	ScheduleRuntimeOptions,
	ScheduleStore,
	ScheduleTaskInput,
	ScheduleType,
} from "./types.js";
export { parseWhenSpec } from "./parser.js";
export { createRunnerScript } from "./runner-script.js";
export { createScheduleStore, readIndex } from "./store.js";

const execFileAsync = promisify(execFile);
const CRON_BEGIN = "# MAGPIE-SCHEDULE-BEGIN";
const CRON_END = "# MAGPIE-SCHEDULE-END";
const SCHEDULE_BACKGROUND_PROMPT = [
	"You are running as a scheduled background Magpie task.",
	"Actually perform the requested work in the working directory using tools when needed.",
	"Do not merely describe what you would do if a file edit, shell command, or write is required.",
	"Be concise in final output, but make the real changes.",
].join(" ");

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
	const activeEntries = entries.filter((entry) => !entry.cancelledAt && entry.task === input.task);
	if (!input.enabled || !input.schedule?.trim()) {
		for (const entry of activeEntries) {
			await cancelScheduledEntry(entry);
			entry.cancelledAt = new Date().toISOString();
		}
		if (activeEntries.length > 0) await writeIndex(store, entries);
		return undefined;
	}
	const cronWhen = input.schedule.trim().startsWith("cron:") ? input.schedule.trim() : `cron:${input.schedule.trim()}`;
	const existing = activeEntries.find((entry) => entry.when === cronWhen && entry.cwd === targetCwd);
	if (existing) {
		const duplicates = activeEntries.filter((entry) => entry !== existing);
		for (const entry of duplicates) {
			await cancelScheduledEntry(entry);
			entry.cancelledAt = new Date().toISOString();
		}
		if (duplicates.length > 0) await writeIndex(store, entries);
		return existing;
	}
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
