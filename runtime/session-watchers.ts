import type { HostedSessionListener, SessionWatcher } from "./session-host-types.js";

export type SessionListenerRegistry = Map<string, Set<HostedSessionListener>>;
export type SessionWatcherRegistry = Map<string, Map<HostedSessionListener, SessionWatcher>>;

export function addSessionSubscriber(
	listeners: SessionListenerRegistry,
	watchers: SessionWatcherRegistry,
	sessionId: string,
	listener: HostedSessionListener,
	watcher?: SessionWatcher,
) {
	const sessionListeners = listeners.get(sessionId) ?? new Set<HostedSessionListener>();
	sessionListeners.add(listener);
	listeners.set(sessionId, sessionListeners);

	let watcherChanged = false;
	if (watcher) {
		const sessionWatchers = watchers.get(sessionId) ?? new Map<HostedSessionListener, SessionWatcher>();
		watcherChanged = !sessionWatchers.has(listener);
		sessionWatchers.set(listener, watcher);
		watchers.set(sessionId, sessionWatchers);
	}
	return { watcherChanged };
}

export function removeSessionSubscriber(
	listeners: SessionListenerRegistry,
	watchers: SessionWatcherRegistry,
	sessionId: string,
	listener: HostedSessionListener,
) {
	const sessionListeners = listeners.get(sessionId);
	if (sessionListeners) {
		sessionListeners.delete(listener);
		if (sessionListeners.size === 0) listeners.delete(sessionId);
	}

	const sessionWatchers = watchers.get(sessionId);
	if (!sessionWatchers) return { watcherRemoved: false };
	const watcherRemoved = sessionWatchers.delete(listener);
	if (sessionWatchers.size === 0) watchers.delete(sessionId);
	return { watcherRemoved };
}

export function getSessionWatchers(watchers: SessionWatcherRegistry, sessionId: string): SessionWatcher[] {
	return [...(watchers.get(sessionId)?.values() ?? [])];
}

export function clearSessionWatchers(watchers: SessionWatcherRegistry, sessionId: string) {
	watchers.delete(sessionId);
}
