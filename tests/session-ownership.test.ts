import { describe, expect, test } from "bun:test";
import {
	canActorMutateCodingSession,
	canClaimCodingOwnership,
	deriveAssistantOwner,
	deriveCodingOwner,
	isSameOwner,
	resolveCodingMessageOwner,
} from "../runtime/session-ownership.js";
import type { SessionOwner } from "../runtime/session-host-types.js";

const local: SessionOwner = { kind: "local_tui", hostId: "h1", actorId: "a" };
const sameLocal: SessionOwner = { kind: "local_tui", hostId: "h1", actorId: "a" };
const remoteWeb: SessionOwner = { kind: "remote_web", hostId: "h1" };
const remoteDispatch: SessionOwner = { kind: "remote_dispatch", hostId: "h1" };

describe("session ownership", () => {
	test("matches owners by kind, host, and actor only", () => {
		expect(isSameOwner(local, sameLocal)).toBe(true);
		expect(isSameOwner(local, { ...sameLocal, actorId: "other" })).toBe(false);
		expect(isSameOwner(local, undefined)).toBe(false);
	});

	test("allows only same-owner claims and same-host remote web mutations of dispatched sessions", () => {
		expect(canClaimCodingOwnership(undefined, local)).toBe(true);
		expect(canClaimCodingOwnership(local, sameLocal)).toBe(true);
		expect(canClaimCodingOwnership(local, remoteWeb)).toBe(false);
		expect(canActorMutateCodingSession(remoteDispatch, remoteWeb)).toBe(true);
		expect(canActorMutateCodingSession(remoteDispatch, { ...remoteWeb, hostId: "h2" })).toBe(false);
	});

	test("derives coding owners from host role, origin, and source", () => {
		expect(deriveCodingOwner("h1", "local", "remote", "schedule").kind).toBe("schedule");
		expect(deriveCodingOwner("h1", "remote", "local", "web").kind).toBe("remote_dispatch");
		expect(deriveCodingOwner("h1", "remote", "remote", "web").kind).toBe("remote_web");
	});

	test("resolveCodingMessageOwner preserves valid existing owner and rejects invalid mutation", () => {
		expect(resolveCodingMessageOwner("h1", "remote", { owner: remoteDispatch, origin: "local", sessionPath: "s.jsonl" }, { text: "x", source: "web" })).toBe(remoteDispatch);
		expect(() => resolveCodingMessageOwner("h1", "remote", { owner: local, origin: "remote", sessionPath: "s.jsonl" }, { text: "x", actor: remoteWeb })).toThrow("explicit transfer is required");
	});

	test("derives assistant owners by channel/source", () => {
		expect(deriveAssistantOwner("h1", "telegram", "web").kind).toBe("system");
		expect(deriveAssistantOwner("h1", "web", "system").kind).toBe("remote_web");
		expect(deriveAssistantOwner("h1", "internal", "schedule").kind).toBe("schedule");
	});
});
