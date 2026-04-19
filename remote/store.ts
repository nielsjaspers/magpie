import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DispatchPayload, ExportedSessionBundle, FetchPayload } from "./types.js";
import { deserializeSessionBundle, serializeSessionBundle, type SerializedSessionBundle } from "./transport.js";

export interface RemoteStoredSessionRecord {
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	payload: DispatchPayload;
	bundlePath: string;
	archivedAt?: string;
}

interface RemoteStoreIndex {
	sessions: Record<string, RemoteStoredSessionRecord>;
}

export interface RemoteBundleStore {
	baseDir: string;
	activeDir: string;
	archiveDir: string;
	indexPath: string;
}

export function createRemoteBundleStore(baseDir = resolve(homedir(), ".pi/agent/magpie-remote")): RemoteBundleStore {
	return {
		baseDir,
		activeDir: resolve(baseDir, "active"),
		archiveDir: resolve(baseDir, "archive"),
		indexPath: resolve(baseDir, "index.json"),
	};
}

async function ensureStore(store: RemoteBundleStore) {
	await mkdir(store.activeDir, { recursive: true });
	await mkdir(store.archiveDir, { recursive: true });
}

async function readIndex(store: RemoteBundleStore): Promise<RemoteStoreIndex> {
	await ensureStore(store);
	if (!existsSync(store.indexPath)) return { sessions: {} };
	try {
		return JSON.parse(await readFile(store.indexPath, "utf8")) as RemoteStoreIndex;
	} catch {
		return { sessions: {} };
	}
}

async function writeIndex(store: RemoteBundleStore, index: RemoteStoreIndex) {
	await ensureStore(store);
	await writeFile(store.indexPath, JSON.stringify(index, null, 2), "utf8");
}

function activeBundlePath(store: RemoteBundleStore, sessionId: string) {
	return resolve(store.activeDir, `${sessionId}.json`);
}

function archiveBundlePath(store: RemoteBundleStore, sessionId: string) {
	return resolve(store.archiveDir, `${sessionId}.json`);
}

export async function storeRemoteBundle(
	store: RemoteBundleStore,
	payload: DispatchPayload,
	bundle: ExportedSessionBundle,
): Promise<RemoteStoredSessionRecord> {
	await ensureStore(store);
	const index = await readIndex(store);
	const now = new Date().toISOString();
	const sessionId = payload.sessionId || bundle.metadata.sessionId;
	const bundlePath = activeBundlePath(store, sessionId);
	const serialized = serializeSessionBundle(bundle);
	await writeFile(bundlePath, JSON.stringify(serialized), "utf8");
	const current = index.sessions[sessionId];
	const record: RemoteStoredSessionRecord = {
		sessionId,
		createdAt: current?.createdAt ?? now,
		updatedAt: now,
		payload: { ...payload, sessionId },
		bundlePath,
	};
	index.sessions[sessionId] = record;
	await writeIndex(store, index);
	return record;
}

export async function listRemoteBundles(store: RemoteBundleStore): Promise<RemoteStoredSessionRecord[]> {
	const index = await readIndex(store);
	return Object.values(index.sessions)
		.filter((record) => !record.archivedAt)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadRemoteBundle(
	store: RemoteBundleStore,
	sessionId: string,
): Promise<{ record: RemoteStoredSessionRecord; serialized: SerializedSessionBundle; bundle: ExportedSessionBundle } | undefined> {
	const index = await readIndex(store);
	const record = index.sessions[sessionId];
	if (!record || record.archivedAt || !existsSync(record.bundlePath)) return undefined;
	const serialized = JSON.parse(await readFile(record.bundlePath, "utf8")) as SerializedSessionBundle;
	return { record, serialized, bundle: deserializeSessionBundle(serialized) };
}

export async function archiveRemoteBundle(
	store: RemoteBundleStore,
	payload: FetchPayload,
): Promise<RemoteStoredSessionRecord | undefined> {
	await ensureStore(store);
	const index = await readIndex(store);
	const record = index.sessions[payload.sessionId];
	if (!record || record.archivedAt || !existsSync(record.bundlePath)) return undefined;
	const archivedPath = archiveBundlePath(store, payload.sessionId);
	const serialized = await readFile(record.bundlePath, "utf8");
	await writeFile(archivedPath, serialized, "utf8");
	await rm(record.bundlePath, { force: true });
	const updated: RemoteStoredSessionRecord = {
		...record,
		updatedAt: new Date().toISOString(),
		bundlePath: archivedPath,
		archivedAt: new Date().toISOString(),
	};
	index.sessions[payload.sessionId] = updated;
	await writeIndex(store, index);
	return updated;
}
