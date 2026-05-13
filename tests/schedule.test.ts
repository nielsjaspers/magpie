import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { JsonStoreCorruptionError } from "../shared/json-store.js";
import { describeEntryStatus, formatEntry } from "../schedule/format.js";
import { createRunnerScript, createScheduleStore, parseWhenSpec, readIndex } from "../schedule/index.js";
import { parseInterpretedScheduleOutput, renderScheduleInterpretProgress } from "../schedule/command.js";
import { formatNotificationSummary } from "../schedule/runtime.js";
import type { ScheduleEntry, ScheduleStore } from "../schedule/types.js";

function baseEntry(patch: Partial<ScheduleEntry> = {}): ScheduleEntry {
	return {
		id: "abc123",
		type: "one-shot",
		cwd: "/tmp/project",
		task: "do work",
		when: "in 5 minutes",
		runAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		backend: "at",
		scriptPath: "/tmp/scripts/abc123.sh",
		createdAt: "2026-01-01T00:00:00.000Z",
		notify: false,
		runs: [],
		...patch,
	};
}

const store: ScheduleStore = {
	baseDir: "/tmp/schedules",
	scriptsDir: "/tmp/schedules/scripts",
	resultsDir: "/tmp/schedules/results",
	indexPath: "/tmp/schedules/index.json",
};

const runtime = {
	notifier: { kind: "none" as const },
	sessionRootDir: "/tmp/schedules/sessions/abc123",
	extensionMode: "builtin" as const,
};

describe("schedule parsing and runner generation", () => {
	test("parses cron-prefixed and natural recurring schedules", () => {
		expect(parseWhenSpec("cron:0 9 * * 1-5")).toMatchObject({ type: "recurring", cronExpr: "0 9 * * 1-5" });
		expect(parseWhenSpec("every day at 9am")).toMatchObject({ type: "recurring", cronExpr: "0 9 * * *" });
		expect(() => parseWhenSpec("cron:not valid")).toThrow("Invalid cron expression");
	});

	test("parses relative one-shot schedules into a future timestamp", () => {
		const parsed = parseWhenSpec("in 5 minutes");

		expect(parsed?.type).toBe("one-shot");
		expect(Date.parse(parsed?.runAt ?? "")).toBeGreaterThan(Date.now());
	});

	test("adds one-shot cron cleanup only when backend is cron_fallback", () => {
		const cronScript = createRunnerScript(store, baseEntry({ backend: "cron_fallback", cronId: "magpie-schedule-abc123" }), "/usr/local/bin/pi", runtime, []);
		const atScript = createRunnerScript(store, baseEntry({ backend: "at" }), "/usr/local/bin/pi", runtime, []);

		expect(cronScript).toContain("grep -v '# magpie-schedule-abc123'");
		expect(atScript).not.toContain("grep -v '# magpie-schedule-abc123'");
	});

	test("runner bootstraps a modern Node for cron environments", () => {
		const script = createRunnerScript(store, baseEntry({ backend: "at" }), "/usr/local/bin/pi", runtime, []);

		expect(script).toContain("pi requires Node.js >= 22");
		expect(script).toContain("$HOME/.nvm/nvm.sh");
		expect(script).toContain("nvm use 22");
		expect(script).toContain("tee -a \"${RESULT_PATH:-/dev/stdout}\"");
	});

	test("loads and normalizes legacy schedule index entries", async () => {
		const store = createScheduleStore(await mkdtemp(resolve(tmpdir(), "magpie-schedule-store-")));
		await writeFile(store.indexPath, JSON.stringify([
			{
				id: "old",
				task: "legacy task",
				cwd: "/tmp/project",
				createdAt: "2026-01-01T00:00:00.000Z",
				resultPath: "/tmp/result.md",
				statePath: "/tmp/state",
				notify: false,
			},
			{ id: "bad" },
		], null, 2), "utf8");

		const entries = await readIndex(store);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "old",
			type: "one-shot",
			backend: "at",
			notify: false,
			resultPath: "/tmp/result.md",
			runs: [{ startedAt: "2026-01-01T00:00:00.000Z", resultPath: "/tmp/result.md", statePath: "/tmp/state" }],
		});
	});

	test("surfaces corrupt schedule index instead of treating it as empty", async () => {
		const store = createScheduleStore(await mkdtemp(resolve(tmpdir(), "magpie-schedule-store-")));
		await writeFile(store.indexPath, "{ invalid", "utf8");
		await expect(readIndex(store)).rejects.toBeInstanceOf(JsonStoreCorruptionError);
	});

	test("formats completed entries from latest run status", () => {
		const entry = baseEntry({
			runs: [{
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:02:00.000Z",
				exitCode: 0,
				resultPath: "/tmp/result.md",
			}],
		});

		expect(describeEntryStatus(entry)).toBe("completed (0) at 2026-01-01T00:02:00.000Z");
		expect(formatEntry(entry)).toContain("- runs: 1");
	});

	test("parses interpreted schedule output and renders progress", () => {
		expect(parseInterpretedScheduleOutput('{"when":"in 5 minutes","task":"check logs","mode":"smart"}')).toEqual({
			when: "in 5 minutes",
			task: "check logs",
			mode: "smart",
			cwd: undefined,
		});
		expect(() => parseInterpretedScheduleOutput('{"error":"nope"}')).toThrow("nope");
		expect(renderScheduleInterpretProgress("partial\nrest", [{ name: "read" }])).toEqual([
			"⏳ schedule: interpreting request",
			"  → read",
			"  partial",
		]);
	});

	test("formats notification summary", () => {
		expect(formatNotificationSummary({ kind: "none" }, true)).toBe("Notification disabled.");
		expect(formatNotificationSummary({ kind: "macos" }, true)).toBe("Notification will be sent via macOS when complete.");
		expect(formatNotificationSummary({ kind: "telegram", botToken: "t", chatId: "c" }, true)).toBe("Notification will be sent via Telegram when complete.");
	});
});
