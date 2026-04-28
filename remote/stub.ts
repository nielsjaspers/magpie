import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface DispatchedStubData {
	remoteHost?: string;
	dispatchedAt?: string;
	remoteSessionId?: string;
	originalSessionPath?: string;
	archivedSessionPath?: string;
}

interface StubSessionContext {
	sessionManager: {
		getEntries(): unknown[];
		getSessionFile(): string | undefined;
	};
}

export async function archiveDispatchedLocalSession(sessionFile: string, remoteHost: string, remoteSessionId: string) {
	const archiveDir = resolve(process.env.HOME || "", ".pi/agent/magpie-dispatched");
	await mkdir(archiveDir, { recursive: true });
	const archivedPath = resolve(archiveDir, basename(sessionFile));
	await rename(sessionFile, archivedPath);
	await mkdir(dirname(sessionFile), { recursive: true });
	await writeFile(sessionFile, JSON.stringify({
		type: "custom",
		customType: "magpie:dispatched-stub",
		timestamp: new Date().toISOString(),
		data: {
			remoteHost,
			dispatchedAt: new Date().toISOString(),
			remoteSessionId,
			originalSessionPath: sessionFile,
			archivedSessionPath: archivedPath,
		},
	}) + "\n", "utf8");
	return archivedPath;
}

export function parseDispatchedStubEntry(entry: any): DispatchedStubData | undefined {
	if (!entry || entry.type !== "custom" || entry.customType !== "magpie:dispatched-stub") return undefined;
	return typeof entry.data === "object" && entry.data ? entry.data as DispatchedStubData : undefined;
}

export async function resolveCurrentStub(ctx: StubSessionContext): Promise<DispatchedStubData | undefined> {
	const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
	const fromEntries = [...entries].reverse().map(parseDispatchedStubEntry).find(Boolean);
	if (fromEntries) return fromEntries;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	try {
		const firstLine = (await readFile(sessionFile, "utf8")).split(/\r?\n/, 1)[0];
		if (!firstLine?.trim()) return undefined;
		return parseDispatchedStubEntry(JSON.parse(firstLine));
	} catch {
		return undefined;
	}
}

export async function recoverArchivedStubSession(
	ctx: StubSessionContext,
	stub: DispatchedStubData,
) {
	const archivedPath = stub.archivedSessionPath?.trim();
	const originalPath = stub.originalSessionPath?.trim() || ctx.sessionManager.getSessionFile();
	if (!archivedPath || !existsSync(archivedPath)) throw new Error("Archived local session copy is unavailable.");
	if (!originalPath) throw new Error("Original session path is unavailable.");
	await mkdir(dirname(originalPath), { recursive: true });
	await writeFile(originalPath, await readFile(archivedPath));
	if (archivedPath !== originalPath) await rm(archivedPath, { force: true });
	return originalPath;
}
