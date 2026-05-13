import { randomUUID } from "node:crypto";
import type { AcceptedMessage, HostedSessionRunState } from "./session-host-types.js";

export interface HostedRuntimeState {
	queue: Promise<void>;
	runState: HostedSessionRunState;
	activeTurnId?: string;
	queueDepth: number;
	lastError?: string;
}

export function acceptQueuedTurn(sessionId: string, runtime: HostedRuntimeState): AcceptedMessage {
	const queued = runtime.queueDepth > 0 || runtime.runState === "running";
	runtime.queueDepth += 1;
	return {
		sessionId,
		accepted: true,
		queued,
		runState: queued ? "running" : runtime.runState,
	};
}

export function markRuntimeRunning(runtime: HostedRuntimeState): void {
	runtime.runState = "running";
	runtime.activeTurnId = randomUUID();
	runtime.lastError = undefined;
}

export function markRuntimeIdle(runtime: HostedRuntimeState): void {
	runtime.runState = "idle";
	runtime.activeTurnId = undefined;
	runtime.lastError = undefined;
}

export function markRuntimeError(runtime: HostedRuntimeState, error: unknown): string {
	runtime.runState = "error";
	runtime.activeTurnId = undefined;
	runtime.lastError = error instanceof Error ? error.message : String(error);
	return runtime.lastError;
}

export function finishQueuedTurn(runtime: HostedRuntimeState): void {
	runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
}
