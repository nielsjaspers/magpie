import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	countExistingDigestSessions,
	ensureDigestFiles,
	formatPapersSummary,
	getPaperPaths,
	listStoredPapers,
	makePaperShortId,
	readStoredPaper,
	rebuildAnswersFile,
	savePaper,
	toStoredMetadata,
	writeDigestSession,
} from "../research/storage.js";
import type { NormalizedPaper, PaperFetchResult } from "../research/types.js";

const paper: NormalizedPaper = {
	shortId: "smi26-test-paper",
	title: "Test Paper",
	authors: ["Jane Smith"],
	year: 2026,
	venue: "Conf",
	citationCount: 42,
	tldr: "Short",
	abstract: "Abstract",
	semanticScholarId: "ss",
	arxivId: "2601.00001",
	doi: "10/test",
	url: "https://example.test/paper",
	openAccessPdf: "https://example.test/paper.pdf",
};

const fetchResult: PaperFetchResult = {
	source: "defuddle",
	markdown: "# Paper",
};

describe("research storage", () => {
	test("creates stable short ids and paper paths", () => {
		expect(makePaperShortId({ title: "A Very Interesting Paper!", authors: ["Ada Lovelace"], year: 2026 })).toBe("lov26-a-very-interesting-paper");
		expect(makePaperShortId({ title: "", authors: [], year: undefined })).toBe("unkxx-paper");
		expect(getPaperPaths("/tmp/papers", "abc")).toMatchObject({
			paperDir: "/tmp/papers/abc",
			metadataPath: "/tmp/papers/abc/metadata.json",
			paperPath: "/tmp/papers/abc/paper.md",
		});
	});

	test("saves, reads, lists, and formats papers", async () => {
		const baseDir = await mkdtemp(resolve("/tmp", "magpie-papers-"));
		const metadata = toStoredMetadata(paper, "2026-01-01T00:00:00.000Z", fetchResult);
		await savePaper(baseDir, metadata, fetchResult.markdown);

		const stored = await readStoredPaper(baseDir, paper.shortId);
		expect(stored?.metadata).toMatchObject({ short_id: paper.shortId, markdown_available: true });
		expect(stored?.paperMarkdown).toBe("# Paper\n");
		expect((await listStoredPapers(baseDir)).map((record) => record.metadata.short_id)).toEqual([paper.shortId]);
		expect(formatPapersSummary([stored!])).toContain("1. Test Paper");
		expect(await readStoredPaper(baseDir, "missing")).toBeNull();
		expect(formatPapersSummary([])).toBe("No papers found.");
	});

	test("creates digest files, counts sessions, writes sessions, and rebuilds answers", async () => {
		const baseDir = await mkdtemp(resolve("/tmp", "magpie-papers-"));
		const digest = await ensureDigestFiles(baseDir, paper.shortId, new Date("2026-01-01T00:00:00.000Z"));

		expect(await readFile(digest.answersPath, "utf8")).toBe("# Answers\n\n");
		await writeDigestSession(resolve(digest.digestDir, "session-a.md"), "## User\n\nFirst question\n\n## Assistant\n\nAnswer");
		await writeDigestSession(resolve(digest.digestDir, "session-b.md"), "## Assistant\n\nIgnored\n\n## User\n\nSecond question");
		expect(await countExistingDigestSessions(baseDir, paper.shortId)).toBe(2);
		await rebuildAnswersFile(digest.digestDir, digest.answersPath);
		expect(await readFile(digest.answersPath, "utf8")).toContain("First question");
		expect(await readFile(digest.answersPath, "utf8")).toContain("Second question");
	});
});
