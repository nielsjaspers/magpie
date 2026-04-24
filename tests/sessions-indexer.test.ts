import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	addPendingIndexEntry,
	appendIndexEntry,
	getPendingIndexPath,
	getSessionIndexPath,
	loadPendingIndexEntries,
	loadSessionIndex,
	saveSessionIndex,
	scoreSessionEntry,
	upsertIndexEntry,
} from "../sessions/indexer.js";
import type { SessionIndexEntry } from "../sessions/types.js";

function entry(sessionPath: string, summary: string): SessionIndexEntry {
	return {
		sessionPath,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		summary,
		topics: ["calendar sync", "remote dispatch"],
		filesModified: ["runtime/session-prompt.ts"],
		modelsUsed: [],
		messageCount: 3,
	};
}

describe("session indexer", () => {
	beforeEach(async () => {
		process.env.PI_CODING_AGENT_DIR = await mkdtemp(resolve(tmpdir(), "magpie-index-test-"));
	});

	test("loads valid JSONL records and ignores corrupt lines", async () => {
		await writeFile(getSessionIndexPath(), `${JSON.stringify(entry("a.jsonl", "alpha"))}\nnot json\n${JSON.stringify(entry("b.jsonl", "beta"))}\n`, "utf8");

		expect((await loadSessionIndex()).map((item) => item.sessionPath)).toEqual(["a.jsonl", "b.jsonl"]);
	});

	test("trims saved index and upserts by session path", async () => {
		await saveSessionIndex([entry("a", "a"), entry("b", "b"), entry("c", "c")], 2);
		expect((await loadSessionIndex()).map((item) => item.sessionPath)).toEqual(["b", "c"]);

		await upsertIndexEntry(entry("b", "updated"), 10);
		expect(await loadSessionIndex()).toMatchObject([{ sessionPath: "c" }, { sessionPath: "b", summary: "updated" }]);
	});

	test("dedupes pending entries by session path", async () => {
		await addPendingIndexEntry({ sessionPath: "a", createdAt: "one" });
		await addPendingIndexEntry({ sessionPath: "a", createdAt: "two" });

		expect(await loadPendingIndexEntries()).toEqual([{ sessionPath: "a", createdAt: "one" }]);
		expect(getPendingIndexPath()).toContain("magpie-index-pending.jsonl");
	});

	test("scores exact query matches higher than token matches", () => {
		const exact = scoreSessionEntry(entry("a", "calendar sync"), "calendar sync");
		const token = scoreSessionEntry(entry("b", "calendar only"), "calendar sync");

		expect(exact).toBeGreaterThan(token);
	});

	test("appends index entries", async () => {
		await appendIndexEntry(entry("a", "first"), 10);
		await appendIndexEntry(entry("b", "second"), 10);

		expect((await loadSessionIndex()).map((item) => item.sessionPath)).toEqual(["a", "b"]);
	});
});
