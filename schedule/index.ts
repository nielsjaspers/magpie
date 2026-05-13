import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { cancelScheduledEntry, chooseBackend, resolveCommandPath, scheduleEntry } from "./backends.js";
import { handleScheduleCommand } from "./command.js";
import { parseWhenSpec } from "./parser.js";
import { createRunnerScript } from "./runner-script.js";
import { createScheduleStore, ensureStore, readIndex, writeIndex } from "./store.js";
import {
	createScheduleId,
	formatNotificationSummary,
	getMagpieExtensionPaths,
	resolveScheduleRuntimeOptions,
} from "./runtime.js";
import type {
	ScheduleEntry,
	ScheduleTaskInput,
} from "./types.js";
export { parseWhenSpec } from "./parser.js";
export { createRunnerScript } from "./runner-script.js";
export { createScheduleStore, readIndex } from "./store.js";
export { cancelScheduledEntry } from "./backends.js";

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
	const id = createScheduleId();
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
		handler: async (args, ctx) => await handleScheduleCommand(args, ctx, subagentCore, scheduleTask),
	});
}
