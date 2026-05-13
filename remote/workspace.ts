import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceArchiveOptions {
	excludes?: string[];
	maxBytes?: number;
}

export async function createWorkspaceArchiveFromDir(cwd: string, options: WorkspaceArchiveOptions = {}): Promise<Buffer> {
	if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
	const args = ["-czf", "-"];
	for (const pattern of options.excludes ?? []) args.push(`--exclude=${pattern}`);
	args.push("-C", cwd, ".");
	const maxBuffer = options.maxBytes ? Math.max(options.maxBytes * 2, options.maxBytes + 1024 * 1024) : 1024 * 1024 * 1024;
	const { stdout } = await execFileAsync("tar", args, { encoding: "buffer", maxBuffer });
	const archive = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as any);
	if (options.maxBytes && archive.byteLength > options.maxBytes) {
		throw new Error(`Workspace archive exceeds maxBytes (${archive.byteLength} > ${options.maxBytes})`);
	}
	return archive;
}

export async function extractWorkspaceArchiveToDir(archive: Uint8Array, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	const tempDir = await mkdtemp(resolve(tmpdir(), "magpie-workspace-"));
	const archivePath = resolve(tempDir, "workspace.tar.gz");
	try {
		await writeFile(archivePath, Buffer.from(archive));
		const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
		const entries = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		for (const entry of entries) {
			if (entry.startsWith("/") || entry.split("/").includes("..")) {
				throw new Error(`Unsafe workspace archive entry: ${entry}`);
			}
		}
		await execFileAsync("tar", ["-xzf", archivePath, "-C", targetDir], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export async function ensureCleanDirectory(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
	await mkdir(path, { recursive: true });
}

export async function ensureParentDir(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

export async function readWorkspaceFile(path: string): Promise<Buffer> {
	return await readFile(path);
}
