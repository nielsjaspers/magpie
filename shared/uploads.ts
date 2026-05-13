import { isAbsolute, relative, resolve, sep } from "node:path";

export function sanitizeUploadedFilename(name: string, fallback = "upload.bin"): string {
	const safe = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!safe || safe === "." || safe === "..") return fallback;
	return safe;
}

export function resolveContainedPath(baseDir: string, filename: string): string {
	const base = resolve(baseDir);
	const target = resolve(base, filename);
	const rel = relative(base, target);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Invalid filename");
	}
	return target;
}
