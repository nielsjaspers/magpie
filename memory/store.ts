import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { MemoryConfig } from "./types.js";
import { expandHomePath } from "../config/config.js";

function getBaseDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
}

function slugify(input: string): string {
	const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return slug || "memory";
}

function filenameTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function ensureWithinRoot(rootDir: string, targetPath: string): string {
	if (targetPath === rootDir || targetPath.startsWith(`${rootDir}${sep}`)) return targetPath;
	throw new Error(`Path escapes memory root: ${targetPath}`);
}

export function getDefaultMemoryRootDir(): string {
	return resolve(getBaseDir(), "magpie-memory");
}

export function getMemoryRootDir(config?: MemoryConfig): string {
	return expandHomePath(config?.rootDir?.trim() || getDefaultMemoryRootDir());
}

export function getMemoryPaths(rootDir: string) {
	const inboxDir = resolve(rootDir, "inbox");
	const graphDir = resolve(rootDir, "graph");
	const archiveDir = resolve(rootDir, "archive");
	const digestDir = resolve(rootDir, "digest");
	const dailyDigestDir = resolve(digestDir, "daily");
	const reviewDir = resolve(rootDir, "review");
	const dreamsDir = resolve(archiveDir, "dreams");
	const telegramArchiveDir = resolve(archiveDir, "telegram");
	const sessionArchiveDir = resolve(archiveDir, "sessions");
	return {
		rootDir,
		inboxDir,
		graphDir,
		archiveDir,
		digestDir,
		dailyDigestDir,
		reviewDir,
		dreamsDir,
		telegramArchiveDir,
		sessionArchiveDir,
	};
}

export async function ensureMemoryDirs(rootDir: string) {
	const paths = getMemoryPaths(rootDir);
	await Promise.all([
		mkdir(paths.rootDir, { recursive: true }),
		mkdir(paths.inboxDir, { recursive: true }),
		mkdir(paths.graphDir, { recursive: true }),
		mkdir(paths.archiveDir, { recursive: true }),
		mkdir(paths.digestDir, { recursive: true }),
		mkdir(paths.dailyDigestDir, { recursive: true }),
		mkdir(paths.reviewDir, { recursive: true }),
		mkdir(paths.dreamsDir, { recursive: true }),
		mkdir(paths.telegramArchiveDir, { recursive: true }),
		mkdir(paths.sessionArchiveDir, { recursive: true }),
	]);
	return paths;
}

export function resolveMemoryPath(rootDir: string, path = "."): string {
	return ensureWithinRoot(rootDir, resolve(rootDir, path));
}

export interface CreatedInboxItem {
	absolutePath: string;
	relativePath: string;
	createdAt: string;
}

export async function createInboxMemoryItem(
	rootDir: string,
	input: { content: string; title?: string; tags?: string[]; source?: string },
): Promise<CreatedInboxItem> {
	const paths = await ensureMemoryDirs(rootDir);
	const createdAt = new Date().toISOString();
	const title = input.title?.trim() || input.content.trim().split(/\r?\n/, 1)[0] || "Memory Capture";
	const fileName = `${filenameTimestamp(new Date(createdAt))}-${slugify(title)}.md`;
	const absolutePath = resolve(paths.inboxDir, fileName);
	const relativePath = relative(rootDir, absolutePath) || fileName;
	const sections = [
		`# ${title}`,
		"",
		`- createdAt: ${createdAt}`,
		`- source: ${input.source?.trim() || "remember"}`,
		input.tags?.length ? `- tags: ${input.tags.join(", ")}` : undefined,
		"",
		input.content.trim(),
	].filter((value): value is string => value !== undefined);
	await writeFile(absolutePath, `${sections.join("\n").trimEnd()}\n`, "utf8");
	return { absolutePath, relativePath, createdAt };
}

export async function writeMemoryFile(
	rootDir: string,
	relativePath: string,
	content: string,
	options?: { append?: boolean },
): Promise<{ absolutePath: string; relativePath: string }> {
	const absolutePath = resolveMemoryPath(rootDir, relativePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	if (options?.append && existsSync(absolutePath)) {
		const current = await readFile(absolutePath, "utf8");
		await writeFile(absolutePath, `${current}${content}`, "utf8");
	} else {
		await writeFile(absolutePath, content, "utf8");
	}
	return { absolutePath, relativePath: relative(rootDir, absolutePath) };
}

export async function inspectMemoryPath(rootDir: string, path = ".") {
	const absolutePath = resolveMemoryPath(rootDir, path);
	const stats = await stat(absolutePath);
	if (stats.isDirectory()) {
		const entries = await readdir(absolutePath, { withFileTypes: true });
		return {
			kind: "directory" as const,
			absolutePath,
			relativePath: relative(rootDir, absolutePath) || ".",
			entries: entries
				.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
				.sort((a, b) => a.localeCompare(b)),
		};
	}
	return {
		kind: "file" as const,
		absolutePath,
		relativePath: relative(rootDir, absolutePath),
		content: await readFile(absolutePath, "utf8"),
	};
}

export interface MemoryFileMatch {
	relativePath: string;
	absolutePath: string;
	score: number;
	content: string;
}

export async function searchMemoryFiles(rootDir: string, query: string, limit = 8): Promise<MemoryFileMatch[]> {
	const lowered = query.toLowerCase();
	const tokens = lowered.split(/\s+/).filter(Boolean);
	const matches: MemoryFileMatch[] = [];

	const walk = async (dir: string) => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const absolutePath = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(absolutePath);
				continue;
			}
			if (!entry.isFile()) continue;
			let content = "";
			try {
				content = await readFile(absolutePath, "utf8");
			} catch {
				continue;
			}
			const relativePath = relative(rootDir, absolutePath);
			const haystack = `${relativePath}\n${content}`.toLowerCase();
			const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 2 : 0), 0)
				+ (haystack.includes(lowered) ? 3 : 0);
			if (score <= 0) continue;
			matches.push({ relativePath, absolutePath, score, content });
		}
	};

	await ensureMemoryDirs(rootDir);
	await walk(rootDir);
	return matches.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)).slice(0, limit);
}

export interface StoredMemoryFile {
	relativePath: string;
	absolutePath: string;
	content: string;
}

export async function listMemoryFiles(rootDir: string, relativeDir: string, options?: { recursive?: boolean; extensions?: string[] }): Promise<StoredMemoryFile[]> {
	const startDir = resolveMemoryPath(rootDir, relativeDir);
	const files: StoredMemoryFile[] = [];
	const allowedExtensions = options?.extensions?.map((value) => value.toLowerCase());

	const walk = async (dir: string) => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const absolutePath = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				if (options?.recursive !== false) await walk(absolutePath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (allowedExtensions?.length && !allowedExtensions.includes(extname(entry.name).toLowerCase())) continue;
			let content = "";
			try {
				content = await readFile(absolutePath, "utf8");
			} catch {
				continue;
			}
			files.push({ relativePath: relative(rootDir, absolutePath), absolutePath, content });
		}
	};

	if (!existsSync(startDir)) return [];
	await walk(startDir);
	return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function getLocalDateParts(date: Date, timeZone: string): { dayStamp: string; timestampStamp: string } {
	const dayFormatter = new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = dayFormatter.formatToParts(date);
	const year = parts.find((part) => part.type === "year")?.value ?? "0000";
	const month = parts.find((part) => part.type === "month")?.value ?? "00";
	const day = parts.find((part) => part.type === "day")?.value ?? "00";
	const timeFormatter = new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const ts = timeFormatter.format(date).replace(" ", "T").replace(/:/g, "-");
	return { dayStamp: `${year}-${month}-${day}`, timestampStamp: ts };
}

export async function writeDailyDigest(rootDir: string, dayStamp: string, content: string) {
	return await writeMemoryFile(rootDir, `digest/daily/${dayStamp}.md`, content);
}

export async function writeReviewFile(rootDir: string, dayStamp: string, content: string) {
	return await writeMemoryFile(rootDir, `review/${dayStamp}.md`, content);
}

export async function writeDreamArchive(rootDir: string, timestampStamp: string, content: string) {
	return await writeMemoryFile(rootDir, `archive/dreams/${timestampStamp}.md`, content);
}

export async function writeTelegramArchive(rootDir: string, timestampStamp: string, content: string) {
	return await writeMemoryFile(rootDir, `archive/telegram/${timestampStamp}.md`, content);
}

export async function moveInboxItemsToArchive(rootDir: string, relativePaths: string[], timestampStamp: string) {
	const moved: Array<{ from: string; to: string }> = [];
	for (const relativePath of relativePaths) {
		const source = resolveMemoryPath(rootDir, relativePath);
		if (!existsSync(source)) continue;
		const destination = resolveMemoryPath(rootDir, `archive/dreams/${timestampStamp}/inbox/${basename(relativePath)}`);
		await mkdir(dirname(destination), { recursive: true });
		await rename(source, destination);
		moved.push({ from: relativePath, to: relative(rootDir, destination) });
	}
	return moved;
}

export async function removeMemoryFiles(rootDir: string, relativePaths: string[]) {
	for (const relativePath of relativePaths) {
		const absolutePath = resolveMemoryPath(rootDir, relativePath);
		if (existsSync(absolutePath)) await unlink(absolutePath);
	}
}

export function formatStoredFiles(files: StoredMemoryFile[], heading: string) {
	if (files.length === 0) return `${heading}: none`;
	return [heading, ...files.map((file) => `## ${file.relativePath}\n\n${file.content.trim()}`)].join("\n\n");
}
