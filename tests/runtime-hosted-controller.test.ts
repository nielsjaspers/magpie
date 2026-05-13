import { describe, expect, test } from "bun:test";
import {
	acceptQueuedTurn,
	finishQueuedTurn,
	markRuntimeError,
	markRuntimeIdle,
	markRuntimeRunning,
	type HostedRuntimeState,
} from "../runtime/hosted-runtime-controller.js";

function runtime(): HostedRuntimeState {
	return {
		queue: Promise.resolve(),
		runState: "idle",
		queueDepth: 0,
	};
}

describe("hosted runtime controller", () => {
	test("accepts queued turns and keeps queue depth explicit", () => {
		const state = runtime();
		expect(acceptQueuedTurn("s1", state)).toMatchObject({ sessionId: "s1", accepted: true, queued: false, runState: "idle" });
		expect(state.queueDepth).toBe(1);
		expect(acceptQueuedTurn("s1", state)).toMatchObject({ queued: true, runState: "running" });
		expect(state.queueDepth).toBe(2);
		finishQueuedTurn(state);
		finishQueuedTurn(state);
		finishQueuedTurn(state);
		expect(state.queueDepth).toBe(0);
	});

	test("moves through running, idle, and error states", () => {
		const state = runtime();
		markRuntimeRunning(state);
		expect(state.runState).toBe("running");
		expect(state.activeTurnId).toBeTruthy();
		markRuntimeIdle(state);
		expect(state).toMatchObject({ runState: "idle", activeTurnId: undefined, lastError: undefined });
		expect(markRuntimeError(state, new Error("boom"))).toBe("boom");
		expect(state).toMatchObject({ runState: "error", activeTurnId: undefined, lastError: "boom" });
	});
});
