import type { HostedSessionMetadata } from "../runtime/session-host-types.js";

export interface DispatchPayload {
	sessionId: string;
	originalCwd?: string;
	dispatchedAt: string;
	magpieVersion?: string;
	piVersion?: string;
	note?: string;
}

export interface FetchPayload {
	sessionId: string;
	fetchedAt: string;
	targetCwd?: string;
}

export interface DeviceRecord {
	id: string;
	name: string;
	platform: string;
	tokenHash: string;
	enrolledAt: string;
	lastSeenAt: string;
	revoked: boolean;
}

export interface ExportedSessionBundle {
	metadata: HostedSessionMetadata;
	sessionJsonl: Uint8Array;
	workspace?: {
		archive: Uint8Array;
		format: "tar.gz";
	};
}
