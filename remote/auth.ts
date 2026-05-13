import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { DeviceRecord } from "./types.js";
import { readJsonStore, writeJsonStore } from "../shared/json-store.js";

interface EnrollmentCodeRecord {
	code: string;
	createdAt: string;
	expiresAt: string;
	usedAt?: string;
}

interface AuthStoreIndex {
	devices: DeviceRecord[];
	enrollmentCodes: EnrollmentCodeRecord[];
}

export interface RemoteAuthStore {
	baseDir: string;
	indexPath: string;
}

export function createRemoteAuthStore(baseDir = resolve(homedir(), ".pi/agent/magpie-remote")): RemoteAuthStore {
	return {
		baseDir,
		indexPath: resolve(baseDir, "auth.json"),
	};
}

async function ensureStore(store: RemoteAuthStore) {
	await mkdir(store.baseDir, { recursive: true });
}

async function readIndex(store: RemoteAuthStore): Promise<AuthStoreIndex> {
	await ensureStore(store);
	return readJsonStore(store.indexPath, normalizeAuthStoreIndex);
}

async function writeIndex(store: RemoteAuthStore, index: AuthStoreIndex) {
	await ensureStore(store);
	await writeJsonStore(store.indexPath, index);
}

function normalizeAuthStoreIndex(value: unknown): AuthStoreIndex {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { devices: [], enrollmentCodes: [] };
	const raw = value as Partial<AuthStoreIndex>;
	return {
		devices: Array.isArray(raw.devices) ? raw.devices : [],
		enrollmentCodes: Array.isArray(raw.enrollmentCodes) ? raw.enrollmentCodes : [],
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function createEnrollmentCode(store: RemoteAuthStore, ttlMinutes = 5): Promise<EnrollmentCodeRecord> {
	const index = await readIndex(store);
	const now = new Date();
	const record: EnrollmentCodeRecord = {
		code: randomBytes(4).toString("hex").toUpperCase(),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
	};
	index.enrollmentCodes = index.enrollmentCodes.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now());
	index.enrollmentCodes.push(record);
	await writeIndex(store, index);
	return record;
}

export async function consumeEnrollmentCode(
	store: RemoteAuthStore,
	input: { code: string; deviceName: string; platform: string },
): Promise<{ device: DeviceRecord; token: string }> {
	const index = await readIndex(store);
	const normalizedCode = input.code.trim().toUpperCase();
	const record = index.enrollmentCodes.find((item) => item.code === normalizedCode);
	if (!record || record.usedAt || Date.parse(record.expiresAt) <= Date.now()) {
		throw new Error("Enrollment code is invalid or expired");
	}
	const token = randomBytes(32).toString("hex");
	const now = new Date().toISOString();
	const device: DeviceRecord = {
		id: randomUUID(),
		name: input.deviceName.trim() || input.platform,
		platform: input.platform.trim() || "unknown",
		tokenHash: sha256(token),
		enrolledAt: now,
		lastSeenAt: now,
		revoked: false,
	};
	index.devices.push(device);
		record.usedAt = now;
	await writeIndex(store, index);
	return { device, token };
}

export async function authenticateRequest(store: RemoteAuthStore, req: IncomingMessage): Promise<DeviceRecord | undefined> {
	const token = extractBearerToken(req);
	if (!token) return undefined;
	const index = await readIndex(store);
	const hash = sha256(token);
	const device = index.devices.find((item) => item.tokenHash === hash && !item.revoked);
	if (!device) return undefined;
	device.lastSeenAt = new Date().toISOString();
	await writeIndex(store, index);
	return device;
}

export async function listEnrolledDevices(store: RemoteAuthStore): Promise<DeviceRecord[]> {
	const index = await readIndex(store);
	return index.devices;
}

export async function revokeEnrolledDevice(store: RemoteAuthStore, deviceId: string): Promise<DeviceRecord | undefined> {
	const index = await readIndex(store);
	const device = index.devices.find((item) => item.id === deviceId);
	if (!device) return undefined;
	device.revoked = true;
	device.lastSeenAt = new Date().toISOString();
	await writeIndex(store, index);
	return device;
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
	const cookie = req.headers.cookie;
	if (!cookie) return undefined;
	for (const part of cookie.split(/;\s*/)) {
		const [key, ...rest] = part.split("=");
		if (key === "magpie_token") return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
	const remoteAddress = req.socket.remoteAddress || "";
	return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}
