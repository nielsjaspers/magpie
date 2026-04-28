import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { listSessionFiles } from "../sessions/indexing.js";
import { dedupeSessionEntries, formatSessionListResult } from "../sessions/format.js";
import { parseDateBoundary, parseParentSessionPath } from "../sessions/parse.js";
import type { SessionIndexEntry } from "../sessions/types.js";

function entry(sessionPath: string, summary: string): SessionIndexEntry {
	return {
		sessionId: sessionPath,
		sessionPath,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		cwd: "/tmp/project",
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
		await addPendingIndexEntry({ sessionPath: "a", cwd: "/tmp/project", queuedAt: "one", attempts: 0 });
		await addPendingIndexEntry({ sessionPath: "a", cwd: "/tmp/project", queuedAt: "two", attempts: 0 });

		expect(await loadPendingIndexEntries()).toEqual([{ sessionPath: "a", cwd: "/tmp/project", queuedAt: "one", attempts: 0 }]);
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

	test("parses parent session markers and local day boundaries", () => {
		expect(parseParentSessionPath("**Parent session:** `/tmp/session.jsonl`")).toBe("/tmp/session.jsonl");
		expect(parseParentSessionPath("Parent session: ./relative.jsonl")).toBe("./relative.jsonl");
		expect(new Date(parseDateBoundary("2026-01-02", "start")!).getHours()).toBe(0);
		expect(new Date(parseDateBoundary("2026-01-02", "end")!).getHours()).toBe(23);
		expect(parseDateBoundary("not a date", "start")).toBeUndefined();
	});

	test("dedupes session entries by latest endedAt and formats list output", () => {
		const older = entry("same", "older");
		const newer = { ...entry("same", "newer"), endedAt: "2026-01-01T00:02:00.000Z" };
		const deduped = dedupeSessionEntries([older, newer]);

		expect(deduped).toEqual([newer]);
		expect(formatSessionListResult(deduped, { sort: "newest", limit: 10 })).toContain("newer");
	});

	test("lists session JSONL files without index storage files", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "magpie-session-files-"));
		await mkdir(resolve(root, "nested"));
		await writeFile(resolve(root, "a.jsonl"), "", "utf8");
		await writeFile(resolve(root, "magpie-session-index.jsonl"), "", "utf8");
		await writeFile(resolve(root, "nested", "b.jsonl"), "", "utf8");
		await writeFile(resolve(root, "nested", "notes.txt"), "", "utf8");

		expect((await listSessionFiles(root)).map((path) => path.slice(root.length + 1))).toEqual(["a.jsonl", "nested/b.jsonl"]);
	});
});
