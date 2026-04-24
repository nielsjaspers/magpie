import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createRemoteServerRuntime, deleteRemoteSession, acceptDispatch, getStoredRemoteBundle, listRemoteSessions, prepareFetch } from "../remote/server.js";
import { createRemoteBundleStore, archiveRemoteBundle, listRemoteBundles, loadRemoteBundle, storeRemoteBundle } from "../remote/store.js";
import { buildRemoteBundleSnapshot } from "../remote/snapshot.js";
import { deserializeSessionBundle, serializeSessionBundle } from "../remote/transport.js";
import type { ExportedSessionBundle, HostedSessionHandle, HostedSessionMetadata } from "../runtime/session-host-types.js";

function metadata(patch: Partial<HostedSessionMetadata> = {}): HostedSessionMetadata {
	return {
		sessionId: "s1",
		kind: "coding",
		origin: "local",
		location: "local",
		runState: "idle",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		workspaceMode: "attached",
		...patch,
	};
}

function bundle(patch: Partial<ExportedSessionBundle> = {}): ExportedSessionBundle {
	return {
		metadata: metadata(),
		sessionJsonl: Buffer.from([
			JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			"not json",
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ text: "world" }] } }),
		].join("\n")),
		workspace: { archive: Buffer.from("workspace"), format: "tar.gz" },
		...patch,
	};
}

describe("remote bundle transport, store, snapshot, and server", () => {
	test("round-trips serialized session bundles including workspace archive", () => {
		const serialized = serializeSessionBundle(bundle());
		const restored = deserializeSessionBundle(serialized);

		expect(Buffer.from(restored.sessionJsonl).toString("utf8")).toContain("hello");
		expect(Buffer.from(restored.workspace!.archive).toString("utf8")).toBe("workspace");
		expect(restored.workspace?.format).toBe("tar.gz");
	});

	test("builds snapshots from JSONL and ignores corrupt/non-message lines", () => {
		const snapshot = buildRemoteBundleSnapshot(serializeSessionBundle(bundle()), 1);

		expect(snapshot.metadata.sessionId).toBe("s1");
		expect(snapshot.messages).toEqual([{ role: "assistant", text: "world" }]);
	});

	test("stores, lists, loads, and archives remote bundles", async () => {
		const store = createRemoteBundleStore(await mkdtemp(resolve("/tmp", "magpie-remote-store-")));
		const stored = await storeRemoteBundle(store, { sessionId: "s1", sourceHostId: "local" }, bundle());

		expect(stored.sessionId).toBe("s1");
		expect((await listRemoteBundles(store)).map((item) => item.sessionId)).toEqual(["s1"]);
		expect((await loadRemoteBundle(store, "s1"))?.bundle.metadata.sessionId).toBe("s1");
		expect(await archiveRemoteBundle(store, { sessionId: "s1" })).toMatchObject({ sessionId: "s1" });
		expect(await loadRemoteBundle(store, "s1")).toBeUndefined();
		expect(await listRemoteBundles(store)).toEqual([]);
	});

	test("remote server accepts dispatch, prepares fetch, and deletes remote session", async () => {
		const runtime = createRemoteServerRuntime(createRemoteBundleStore(await mkdtemp(resolve("/tmp", "magpie-remote-runtime-"))));
		const sentMessages: unknown[] = [];
		let archivedReason: string | undefined;
		let importedOwner: unknown;
		const handle: HostedSessionHandle = {
			metadata: metadata({ sessionId: "remote-s1", location: "remote" }),
			getPiSession: async () => ({}),
			getStatus: async () => undefined,
			getSnapshot: async () => undefined,
			subscribe: async () => () => {},
			sendUserMessage: async (input) => {
				sentMessages.push(input);
				return { sessionId: "remote-s1", accepted: true, queued: false, runState: "idle" };
			},
			interrupt: async () => {},
			claimOwnership: async () => {},
			releaseOwnership: async () => {},
			archive: async (reason) => {
				archivedReason = reason;
			},
			export: async () => bundle({ metadata: metadata({ sessionId: "remote-s1" }) }),
		};
		const codingHost = {
			hostId: "remote-host",
			importSession: async (input: any) => {
				importedOwner = input.owner;
				return handle;
			},
			getSession: async (sessionId: string) => sessionId === "remote-s1" ? handle : undefined,
		};

		const accepted = await acceptDispatch(runtime, codingHost as any, "opencode/gpt-5-nano", {
			payload: { sessionId: "s1", sourceHostId: "local", note: "continue" },
			bundle: serializeSessionBundle(bundle()),
		});
		expect(accepted.sessionId).toBe("remote-s1");
		expect(importedOwner).toMatchObject({ kind: "remote_dispatch", hostId: "remote-host" });
		expect(sentMessages).toMatchObject([{ text: "continue", modelRef: "opencode/gpt-5-nano", source: "system" }]);
		expect(await listRemoteSessions(runtime)).toHaveLength(1);
		expect(await getStoredRemoteBundle(runtime, "s1")).toBeDefined();
		expect((await prepareFetch(runtime, codingHost as any, { sessionId: "remote-s1" })).bundle.metadata.sessionId).toBe("remote-s1");
		expect(await deleteRemoteSession(runtime, codingHost as any, { sessionId: "remote-s1" })).toMatchObject({ sessionId: "remote-s1" });
		expect(archivedReason).toBe("fetched");
	});
});
