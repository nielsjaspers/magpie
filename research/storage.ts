import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { NormalizedPaper, PaperFetchResult, StoredPaperMetadata, StoredPaperRecord } from "./types.js";

function slugify(input: string): string {
	const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return slug || "paper";
}

function authorPrefix(authors: string[]): string {
	const first = authors[0]?.trim() || "unk";
	const parts = first.split(/\s+/).filter(Boolean);
	const last = parts[parts.length - 1] || first;
	const letters = last.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3);
	return letters.padEnd(3, "x");
}

function yearSuffix(year?: number): string {
	if (!year || !Number.isFinite(year)) return "xx";
	return String(year).slice(-2).padStart(2, "0");
}

export function makePaperShortId(input: { title: string; authors: string[]; year?: number }): string {
	return `${authorPrefix(input.authors)}${yearSuffix(input.year)}-${slugify(input.title)}`;
}

export function getPaperPaths(baseDir: string, shortId: string) {
	const paperDir = resolve(baseDir, shortId);
	const digestDir = join(paperDir, "digest");
	return {
		paperDir,
		metadataPath: join(paperDir, "metadata.json"),
		paperPath: join(paperDir, "paper.md"),
		digestDir,
		answersPath: join(digestDir, "answers.md"),
	};
}

export function toStoredMetadata(paper: NormalizedPaper, fetchedAt: string, fetchResult: PaperFetchResult): StoredPaperMetadata {
	return {
		short_id: paper.shortId,
		title: paper.title,
		authors: paper.authors,
		year: paper.year,
		venue: paper.venue,
		citation_count: paper.citationCount,
		tldr: paper.tldr,
		abstract: paper.abstract,
		semantic_scholar_id: paper.semanticScholarId,
		arxiv_id: paper.arxivId,
		doi: paper.doi,
		url: paper.url,
		open_access_pdf: paper.openAccessPdf,
		fetched_at: fetchedAt,
		source: fetchResult.source,
		markdown_available: Boolean(fetchResult.markdown),
		fetch_error: fetchResult.error,
	};
}

export async function savePaper(baseDir: string, metadata: StoredPaperMetadata, markdown?: string): Promise<StoredPaperRecord> {
	const paths = getPaperPaths(baseDir, metadata.short_id);
	await mkdir(paths.paperDir, { recursive: true });
	await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	if (markdown?.trim()) await writeFile(paths.paperPath, markdown.trimEnd() + "\n", "utf8");
	return {
		metadata,
		...paths,
		paperMarkdown: markdown,
	};
}

export async function ensureDigestFiles(baseDir: string, shortId: string, startedAt: Date) {
	const paths = getPaperPaths(baseDir, shortId);
	await mkdir(paths.digestDir, { recursive: true });
	const sessionTimestamp = startedAt.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
	const sessionFile = join(paths.digestDir, `session-${sessionTimestamp}.md`);
	if (!existsSync(paths.answersPath)) await writeFile(paths.answersPath, "# Answers\n\n", "utf8");
	return { ...paths, sessionFile };
}

export async function countExistingDigestSessions(baseDir: string, shortId: string): Promise<number> {
	const { digestDir } = getPaperPaths(baseDir, shortId);
	if (!existsSync(digestDir)) return 0;
	const entries = await readdir(digestDir, { withFileTypes: true });
	return entries.filter((entry) => entry.isFile() && /^session-.*\.md$/i.test(entry.name)).length;
}

export async function readStoredPaper(baseDir: string, shortId: string): Promise<StoredPaperRecord | null> {
	const paths = getPaperPaths(baseDir, shortId);
	if (!existsSync(paths.metadataPath)) return null;
	try {
		const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as StoredPaperMetadata;
		const paperMarkdown = existsSync(paths.paperPath) ? await readFile(paths.paperPath, "utf8") : undefined;
		return { metadata, ...paths, paperMarkdown };
	} catch {
		return null;
	}
}

export async function listStoredPapers(baseDir: string): Promise<StoredPaperRecord[]> {
	if (!existsSync(baseDir)) return [];
	const entries = await readdir(baseDir, { withFileTypes: true });
	const papers: StoredPaperRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const record = await readStoredPaper(baseDir, entry.name);
		if (record) papers.push(record);
	}
	papers.sort((a, b) => a.metadata.short_id.localeCompare(b.metadata.short_id));
	return papers;
}

export function formatPapersSummary(records: StoredPaperRecord[]): string {
	if (records.length === 0) return "No papers found.";
	return records.map((record, index) => {
		const firstAuthor = record.metadata.authors[0] || "Unknown author";
		const year = record.metadata.year ?? "n.d.";
		const citations = record.metadata.citation_count ?? 0;
		const tldr = record.metadata.tldr?.trim() || "(no TLDR)";
		const fetched = record.metadata.markdown_available ? "yes" : `no${record.metadata.fetch_error ? ` (${record.metadata.fetch_error})` : ""}`;
		return [
			`${index + 1}. ${record.metadata.title}`,
			`   - author: ${firstAuthor}`,
			`   - year: ${year}`,
			`   - citations: ${citations}`,
			`   - short_id: ${record.metadata.short_id}`,
			`   - markdown: ${fetched}`,
			`   - tldr: ${tldr}`,
		].join("\n");
	}).join("\n");
}

export async function writeDigestSession(sessionFile: string, content: string) {
	await writeFile(sessionFile, content.trimEnd() + "\n", "utf8");
}

export async function rebuildAnswersFile(digestDir: string, answersPath: string) {
	if (!existsSync(digestDir)) return;
	const entries = await readdir(digestDir, { withFileTypes: true });
	const sessionFiles = entries
		.filter((entry) => entry.isFile() && /^session-.*\.md$/i.test(entry.name))
		.map((entry) => join(digestDir, entry.name))
		.sort((a, b) => basename(a).localeCompare(basename(b)));
	const sections: string[] = ["# Answers", ""];
	for (const sessionFile of sessionFiles) {
		const raw = await readFile(sessionFile, "utf8");
		const userBlocks = Array.from(raw.matchAll(/## User\n\n([\s\S]*?)(?=\n## (?:User|Assistant)\n|$)/g))
			.map((match) => match[1]?.trim())
			.filter((value): value is string => Boolean(value));
		if (userBlocks.length === 0) continue;
		sections.push(`## ${basename(sessionFile, ".md")}`);
		sections.push("");
		for (const block of userBlocks) {
			sections.push(block);
			sections.push("");
		}
	}
	await writeFile(answersPath, `${sections.join("\n").trimEnd()}\n`, "utf8");
}
