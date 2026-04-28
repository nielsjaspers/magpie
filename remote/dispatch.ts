import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { getRemoteConfig, type loadConfig } from "../config/config.js";
import type { ExportedSessionBundle } from "../runtime/session-host-types.js";
import { dispatchSession, listDispatchedSessions } from "./client.js";
import { resolveRemoteHost } from "./config.js";
import { createLocalCodingHost, getCurrentSessionModelRef, type CommandContext } from "./host.js";
import { archiveDispatchedLocalSession, type DispatchedStubData } from "./stub.js";
import { serializeSessionBundle } from "./transport.js";
import type { DispatchPayload } from "./types.js";
import { createWorkspaceArchiveFromDir } from "./workspace.js";

export async function checkRemoteSessionExists(config: Awaited<ReturnType<typeof loadConfig>>, stub: DispatchedStubData): Promise<boolean | undefined> {
	const remoteHost = resolveRemoteHost(config, stub.remoteHost);
	const remoteSessionId = stub.remoteSessionId?.trim();
	if (!remoteHost?.baseUrl || !remoteHost.deviceToken || !remoteSessionId) return undefined;
	try {
		const result = await listDispatchedSessions(remoteHost.baseUrl, remoteHost.deviceToken);
		return result.sessions.some((session) => session.sessionId === remoteSessionId);
	} catch {
		return undefined;
	}
}

export async function restoreFetchedLocalSession(
	ctx: CommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	remoteSessionId: string,
	bundle: ExportedSessionBundle,
	stub?: DispatchedStubData,
) {
	const restorePath = stub?.originalSessionPath?.trim()
		|| ctx.sessionManager.getSessionFile()
		|| bundle.metadata.sourceSessionPath?.trim();
	if (!restorePath) throw new Error(`Unable to determine local session path for fetched session ${remoteSessionId}`);
	const localHost = createLocalCodingHost(ctx, config);
	const localOwner = { kind: "local_tui" as const, hostId: localHost.hostId, displayName: "Local TUI" };
	const restoredSession = await localHost.importSession({
		bundle: {
			...bundle,
			metadata: {
				...bundle.metadata,
				location: "local",
				cwd: bundle.metadata.cwd,
				sourceSessionPath: restorePath,
				owner: localOwner,
			},
		},
		owner: localOwner,
	});
	if (stub?.archivedSessionPath?.trim() && existsSync(stub.archivedSessionPath) && stub.archivedSessionPath !== restorePath) {
		await rm(stub.archivedSessionPath, { force: true });
	}
	return {
		restoredPath: restorePath,
		workspacePath: restoredSession.metadata.cwd,
		localHost,
		localOwner,
		sessionId: bundle.metadata.sessionId,
	};
}

export async function dispatchCurrentSession(
	ctx: CommandContext,
	config: Awaited<ReturnType<typeof loadConfig>>,
	note?: string,
	hostName?: string,
) {
	const remoteHost = resolveRemoteHost(config, hostName);
	if (!remoteHost) throw new Error("Configure remote.defaultHost and remote.hosts.<name>.tailscaleUrl/publicUrl first.");
	if (!remoteHost.deviceToken) throw new Error(`No device token configured for ${remoteHost.name}. Run /remote enroll <CODE> first.`);
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Current session file unavailable.");
	const raw = await readFile(sessionFile);
	const sessionId = basename(sessionFile, ".jsonl");
	const now = new Date().toISOString();
	const modelRef = getCurrentSessionModelRef(ctx);
	const remoteConfig = getRemoteConfig(config);
	const workspace = await createWorkspaceArchiveFromDir(ctx.cwd, {
		excludes: remoteConfig?.tarExclude,
		maxBytes: remoteConfig?.maxTarSize,
	});
	const payload: DispatchPayload = {
		sessionId,
		originalCwd: ctx.cwd,
		dispatchedAt: now,
		modelRef,
		note: note?.trim() || undefined,
	};
	const bundle = serializeSessionBundle({
		metadata: {
			sessionId,
			kind: "coding",
			origin: "local",
			location: "remote",
			runState: "idle",
			createdAt: now,
			updatedAt: now,
			title: basename(ctx.cwd),
			workspaceMode: "attached",
			cwd: ctx.cwd,
			sourceSessionPath: sessionFile,
			summary: modelRef,
			owner: {
				kind: "local_tui",
				hostId: "magpie-local-coding-host",
				displayName: "Local TUI",
			},
		},
		sessionJsonl: raw,
		workspace: { archive: workspace, format: "tar.gz" },
	});
	const result = await dispatchSession(remoteHost.baseUrl, payload, bundle, remoteHost.deviceToken);
	await archiveDispatchedLocalSession(sessionFile, remoteHost.name, result.sessionId);
	return { remoteHost, result };
}
