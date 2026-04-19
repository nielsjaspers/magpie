import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export function getPaCalendarDir(storageDir: string): string {
	return resolve(storageDir, "calendar");
}

export function getPaCalendarCacheDir(storageDir: string): string {
	return resolve(getPaCalendarDir(storageDir), "cache");
}

export function getPaCalendarLogsDir(storageDir: string): string {
	return resolve(getPaCalendarDir(storageDir), "logs");
}

export function getPaMailDir(storageDir: string): string {
	return resolve(storageDir, "mail");
}

export function getPaMailContactsDir(storageDir: string): string {
	return resolve(getPaMailDir(storageDir), "contacts");
}

export function getPaMailContactDir(storageDir: string, contactSlug: string): string {
	return resolve(getPaMailContactsDir(storageDir), contactSlug);
}

export function getPaMailContactDraftsDir(storageDir: string, contactSlug: string): string {
	return resolve(getPaMailContactDir(storageDir, contactSlug), "drafts");
}

export function getPaMailHistoryDir(storageDir: string): string {
	return resolve(getPaMailDir(storageDir), "history");
}

export async function ensureDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true });
	return path;
}
