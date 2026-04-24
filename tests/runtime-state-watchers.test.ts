import { describe, expect, test } from "bun:test";
import { addSessionSubscriber, clearSessionWatchers, getSessionWatchers, removeSessionSubscriber } from "../runtime/session-watchers.js";
import { buildHostedSessionStatus, buildHostedSessionSummary } from "../runtime/session-state.js";
import type { HostedSessionListener, SessionWatcher } from "../runtime/session-host-types.js";

describe("session watcher registries and hosted state builders", () => {
	test("adds, removes, lists, and clears watcher metadata", () => {
		const listeners = new Map<string, Set<HostedSessionListener>>();
		const watchers = new Map<string, Map<HostedSessionListener, SessionWatcher>>();
		const listener: HostedSessionListener = () => {};
		const watcher: SessionWatcher = { id: "w1", kind: "web", hostId: "h1" };

		expect(addSessionSubscriber(listeners, watchers, "s1", listener, watcher)).toEqual({ watcherChanged: true });
		expect(addSessionSubscriber(listeners, watchers, "s1", listener, watcher)).toEqual({ watcherChanged: false });
		expect(getSessionWatchers(watchers, "s1")).toEqual([watcher]);
		expect(removeSessionSubscriber(listeners, watchers, "s1", listener)).toEqual({ watcherRemoved: true });
		expect(listeners.has("s1")).toBe(false);
		expect(watchers.has("s1")).toBe(false);

		addSessionSubscriber(listeners, watchers, "s1", listener, watcher);
		clearSessionWatchers(watchers, "s1");
		expect(getSessionWatchers(watchers, "s1")).toEqual([]);
	});

	test("builds summaries and statuses without dropping optional hosted fields", () => {
		const summary = buildHostedSessionSummary({
			sessionId: "s1",
			title: "Title",
			kind: "assistant",
			location: "remote",
			runState: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:01:00.000Z",
			cwd: "/tmp/project",
			watcherCount: 2,
			assistantChannel: "web",
			assistantThreadId: "thread",
			sessionPath: "/tmp/s.jsonl",
			loaded: true,
		});
		const status = buildHostedSessionStatus({
			summary,
			activeTurnId: "turn",
			messageCount: 4,
			queueDepth: 1,
			lastError: "none",
			watchers: [{ id: "w1", kind: "web", hostId: "h1" }],
		});

		expect(summary).toMatchObject({ sessionId: "s1", assistantChannel: "web", loaded: true });
		expect(status).toMatchObject({ activeTurnId: "turn", messageCount: 4, queueDepth: 1, lastError: "none" });
		expect(status.watchers).toHaveLength(1);
	});
});
