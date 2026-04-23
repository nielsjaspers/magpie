import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createInboxMemoryItem,
	formatStoredFiles,
	getLocalDateParts,
	getMemoryPaths,
	inspectMemoryPath,
	listMemoryFiles,
	moveInboxItemsToArchive,
	removeMemoryFiles,
	resolveMemoryPath,
	searchMemoryFiles,
	writeDailyDigest,
	writeDreamArchive,
	writeMemoryFile,
	writeReviewFile,
	writeTelegramArchive,
} from "../memory/store.js";

describe("memory store", () => {
	test("prevents path traversal outside the memory root", async () => {
		const root = await mkdtemp(resolve("/tmp", "magpie-memory-"));

		expect(resolveMemoryPath(root, "notes/a.md")).toBe(resolve(root, "notes/a.md"));
		expect(() => resolveMemoryPath(root, "../escape.md")).toThrow("Path escapes memory root");
	});

	test("creates, writes, inspects, searches, lists, formats, moves, and removes memory files", async () => {
		const root = await mkdtemp(resolve("/tmp", "magpie-memory-"));
		const paths = getMemoryPaths(root);
		const inbox = await createInboxMemoryItem(root, { title: "Project Note", content: "Remember calendar sync", tags: ["calendar"], source: "test" });
		await writeMemoryFile(root, "graph/person.md", "Alice likes remote dispatch", { append: false });
		await writeMemoryFile(root, "graph/person.md", "\nMore notes", { append: true });

		expect(inbox.relativePath.startsWith("inbox/")).toBe(true);
		expect(await inspectMemoryPath(root, "graph/person.md")).toMatchObject({ kind: "file", content: "Alice likes remote dispatch\nMore notes" });
		expect(await inspectMemoryPath(root, "graph")).toMatchObject({ kind: "directory", entries: ["person.md"] });
		expect((await searchMemoryFiles(root, "remote dispatch", 2))[0]).toMatchObject({ relativePath: "graph/person.md" });
		expect(await listMemoryFiles(root, ".", { recursive: true, extensions: [".md"] })).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: "graph/person.md" })]));
		expect(formatStoredFiles([{ relativePath: "x.md", absolutePath: "/x.md", content: "body\n" }], "Files")).toContain("## x.md");

		const moved = await moveInboxItemsToArchive(root, [inbox.relativePath], "2026-01-01T00-00-00");
		expect(moved[0].to).toContain("archive/dreams/2026-01-01T00-00-00/inbox/");
		await removeMemoryFiles(root, ["graph/person.md"]);
		await expect(readFile(resolve(root, "graph/person.md"), "utf8")).rejects.toThrow();
		expect(paths.rootDir).toBe(root);
	});

	test("writes digest/review/archive files and computes local date stamps", async () => {
		const root = await mkdtemp(resolve("/tmp", "magpie-memory-"));

		await writeDailyDigest(root, "2026-01-01", "daily");
		await writeReviewFile(root, "2026-01-01", "review");
		await writeDreamArchive(root, "2026-01-01T00-00-00", "dream");
		await writeTelegramArchive(root, "2026-01-01T00-00-00", "telegram");

		expect(await readFile(resolve(root, "digest/daily/2026-01-01.md"), "utf8")).toBe("daily");
		expect(await readFile(resolve(root, "review/2026-01-01.md"), "utf8")).toBe("review");
		expect(await readFile(resolve(root, "archive/dreams/2026-01-01T00-00-00.md"), "utf8")).toBe("dream");
		expect(await readFile(resolve(root, "archive/telegram/2026-01-01T00-00-00.md"), "utf8")).toBe("telegram");
		expect(getLocalDateParts(new Date("2026-01-01T12:34:56Z"), "UTC")).toEqual({
			dayStamp: "2026-01-01",
			timestampStamp: "2026-01-01T12-34-56",
		});

		await mkdir(resolve(root, "extra"), { recursive: true });
		await writeFile(resolve(root, "extra", "ignored.txt"), "ignored", "utf8");
		expect(await listMemoryFiles(root, "missing", { recursive: true })).toEqual([]);
	});
});
