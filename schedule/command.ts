import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveSubagentModelRef } from "../config/config.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { cancelScheduledEntry } from "./backends.js";
import { expandLogResultPlaceholders, formatEntry, formatLogs } from "./format.js";
import { createScheduleStore, readIndex, writeIndex } from "./store.js";
import type { ScheduleEntry, ScheduleTaskInput } from "./types.js";

type ScheduleTaskFn = (ctx: ExtensionContext, input: ScheduleTaskInput) => Promise<{ entry: ScheduleEntry; notificationSummary: string }>;

export function renderScheduleInterpretProgress(partialOutput: string, toolCalls: Array<{ name: string }>) {
	const lines = ["⏳ schedule: interpreting request"];
	for (const item of toolCalls.slice(-6)) lines.push(`  → ${item.name}`);
	if (partialOutput.trim()) lines.push(`  ${partialOutput.trim().split("\n")[0]}`);
	return lines;
}

export function parseInterpretedScheduleOutput(output: string) {
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

export async function handleScheduleCommand(
	args: string | undefined,
	ctx: ExtensionContext,
	subagentCore: SubagentCoreAPI | null,
	scheduleTask: ScheduleTaskFn,
) {
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
}
