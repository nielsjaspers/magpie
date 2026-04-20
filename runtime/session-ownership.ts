import type { AssistantChannel, HostedSessionMetadata, SendMessageInput, SessionOwner } from "./session-host-types.js";

export function isSameOwner(left: SessionOwner | undefined, right: SessionOwner | undefined) {
	if (!left || !right) return false;
	return left.kind === right.kind && left.hostId === right.hostId && left.actorId === right.actorId;
}

export function canClaimCodingOwnership(currentOwner: SessionOwner | undefined, nextOwner: SessionOwner) {
	if (!currentOwner) return true;
	return isSameOwner(currentOwner, nextOwner);
}

export function canActorMutateCodingSession(currentOwner: SessionOwner, actor: SessionOwner) {
	if (isSameOwner(currentOwner, actor)) return true;
	if (
		currentOwner.kind === "remote_dispatch"
		&& actor.kind === "remote_web"
		&& currentOwner.hostId === actor.hostId
	) {
		return true;
	}
	return false;
}

export function codingOwnershipErrorMessage(sessionPath: string, owner: SessionOwner | undefined, action: "changing ownership" | "mutating" | "interrupting") {
	return `Session ${sessionPath} is owned by ${owner?.displayName || owner?.kind}; explicit transfer is required before ${action}.`;
}

export function deriveCodingOwner(
	hostId: string,
	hostRole: "local" | "remote",
	origin: HostedSessionMetadata["origin"] | undefined,
	source: SendMessageInput["source"],
): SessionOwner {
	if (hostRole === "local") {
		return {
			kind: source === "schedule" ? "schedule" : "local_tui",
			hostId,
			displayName: source === "schedule" ? "Scheduled local run" : "Local TUI",
		};
	}
	if (origin === "local" || origin === "imported") {
		return {
			kind: "remote_dispatch",
			hostId,
			displayName: "Remote dispatched session",
		};
	}
	return {
		kind: source === "schedule" ? "schedule" : "remote_web",
		hostId,
		displayName: source === "schedule" ? "Scheduled remote run" : "Remote web session",
	};
}

export function resolveCodingMessageOwner(
	hostId: string,
	hostRole: "local" | "remote",
	entry: { owner?: SessionOwner; origin?: HostedSessionMetadata["origin"]; sessionPath: string },
	input: SendMessageInput,
): SessionOwner {
	if (input.source === "system") return entry.owner ?? deriveCodingOwner(hostId, hostRole, entry.origin, input.source);
	const actor = input.actor ?? deriveCodingOwner(hostId, hostRole, entry.origin, input.source);
	if (!entry.owner) return actor;
	if (!canActorMutateCodingSession(entry.owner, actor)) {
		throw new Error(codingOwnershipErrorMessage(entry.sessionPath, entry.owner, "mutating"));
	}
	return entry.owner;
}

export function deriveAssistantOwner(hostId: string, channel: AssistantChannel | undefined, source: SendMessageInput["source"]): SessionOwner {
	if (source === "telegram" || channel === "telegram") {
		return { kind: "system", hostId, displayName: "Telegram assistant session" };
	}
	if (source === "web" || channel === "web") {
		return { kind: "remote_web", hostId, displayName: "Remote web assistant session" };
	}
	return {
		kind: source === "schedule" ? "schedule" : "system",
		hostId,
		displayName: source === "schedule" ? "Scheduled assistant session" : "Assistant session",
	};
}
