import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class JsonStoreCorruptionError extends Error {
	readonly path: string;
	readonly cause: unknown;

	constructor(path: string, cause: unknown) {
		super(`Refusing to continue with corrupt JSON store: ${path}. Repair the file or move it aside before retrying.`);
		this.name = "JsonStoreCorruptionError";
		this.path = path;
		this.cause = cause;
	}
}

export async function readJsonStore<T>(path: string, normalize: (value: unknown) => T): Promise<T> {
	if (!existsSync(path)) return normalize(undefined);
	try {
		const text = await readFile(path, "utf8");
		return normalize(JSON.parse(text));
	} catch (error) {
		throw new JsonStoreCorruptionError(path, error);
	}
}

export async function writeJsonStore<T>(path: string, value: T): Promise<void> {
	const tempPath = resolve(dirname(path), `.json-store.${randomUUID()}.tmp`);
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

export function normalizeRecord<T>(value: unknown): Record<string, T> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, T>;
}
