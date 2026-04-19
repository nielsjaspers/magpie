import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type {
	AcceptedMessage,
	AssistantChannel,
	CreateSessionInput,
	HostedSessionEvent,
	HostedSessionListener,
	HostedSessionLocation,
	HostedSessionMetadata,
	HostedSessionRunState,
	HostedSessionSnapshot,
	HostedSessionStatus,
	HostedSessionSummary,
	SessionFilter,
	SessionHost,
	SessionOrigin,
	Unsubscribe,
	WorkspaceMode,
} from "./session-host-types.js";

export interface AssistantSessionHostConfig {
	hostCwd: string;
	storageDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	resolveModel: (ref: string) => unknown;
	buildSystemPrompt: () => Promise<string>;
	tools?: unknown[];
	hostId?: string;
	hostRole?: "local" | "remote";
}

export interface AssistantSessionRuntime {
	sessionPromise: Promise<AgentSession>;
	queue: Promise<void>;
	sessionFilePromise: Promise<string | undefined>;
	runState: HostedSessionRunState;
	queueDepth: number;
	lastError?: string;
}

interface AssistantSessionRegistryEntry {
	sessionPath: string;
	createdAt?: string;
	updatedAt: string;
	kind?: "assistant";
	origin?: SessionOrigin;
	location?: HostedSessionLocation;
	workspaceMode?: WorkspaceMode;
	assistantChannel?: AssistantChannel;
	assistantThreadId?: string;
	title?: string;
	modelRef?: string;
	lastError?: string;
}

type SessionRegistry = Record<string, AssistantSessionRegistryEntry>;

export interface AssistantThreadStatus {
	threadKey: string;
	exists: boolean;
	sessionPath?: string;
	updatedAt?: string;
	loaded: boolean;
	messageCount?: number;
	sessionId?: string;
	createdAt?: string;
	runState?: HostedSessionRunState;
	queueDepth?: number;
	lastError?: string;
	assistantChannel?: AssistantChannel;
	assistantThreadId?: string;
}

export interface AssistantThreadSnapshot extends AssistantThreadStatus {
	messages?: Array<{
		role: string;
		text?: string;
	}>;
}

export type AssistantToolEvent =
	| { type: "start"; toolName: string; args: unknown }
	| { type: "end"; toolName: string; result: string; isError: boolean };

export interface ResolveAssistantSessionInput extends CreateSessionInput {
	kind: "assistant";
	assistantChannel: AssistantChannel;
	assistantThreadId: string;
	modelRef: string;
}

export interface ResolveAssistantSessionResult {
	sessionId: string;
	created: boolean;
	sessionFile?: string;
	metadata: HostedSessionMetadata;
}

export class AssistantSessionHost implements SessionHost {
	readonly hostId: string;
	readonly hostRole: "local" | "remote";

	private readonly hostCwd: string;
	private readonly storageDir: string;
	private readonly sessionsDir: string;
	private readonly registryPath: string;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly resolveModelRef: (ref: string) => unknown;
	private readonly buildSystemPromptText: () => Promise<string>;
	private readonly tools: unknown[] | undefined;
	private readonly runtimes = new Map<string, AssistantSessionRuntime>();
	private readonly listeners = new Map<string, Set<HostedSessionListener>>();

	constructor(config: AssistantSessionHostConfig) {
		this.hostId = config.hostId ?? "magpie-host";
		this.hostRole = config.hostRole ?? "remote";
		this.hostCwd = config.hostCwd;
		this.storageDir = config.storageDir;
		this.sessionsDir = resolve(this.storageDir, "sessions");
		this.registryPath = resolve(this.storageDir, "thread-sessions.json");
		this.authStorage = config.authStorage;
		this.modelRegistry = config.modelRegistry;
		this.resolveModelRef = config.resolveModel;
		this.buildSystemPromptText = config.buildSystemPrompt;
		this.tools = config.tools;
	}

	async listSessions(filter?: SessionFilter): Promise<HostedSessionSummary[]> {
		const registry = await this.readRegistry();
		const summaries = Object.entries(registry)
			.map(([sessionId, entry]) => this.toSummary(sessionId, entry))
			.filter((summary) => this.matchesFilter(summary, filter))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const limit = filter?.limit && filter.limit > 0 ? filter.limit : undefined;
		return limit ? summaries.slice(0, limit) : summaries;
	}

	async getRuntime(threadKey: string, modelRef: string): Promise<AssistantSessionRuntime> {
		let runtime = this.runtimes.get(threadKey);
		if (!runtime) {
			runtime = {
				sessionPromise: this.loadOrCreateSession(threadKey, modelRef),
				queue: Promise.resolve(),
				sessionFilePromise: Promise.resolve(undefined),
				runState: "idle",
				queueDepth: 0,
			};
			runtime.sessionFilePromise = runtime.sessionPromise.then((session) => session.sessionFile);
			this.runtimes.set(threadKey, runtime);
		}
		return runtime;
	}

	async resolveAssistantSession(input: ResolveAssistantSessionInput): Promise<ResolveAssistantSessionResult> {
		const sessionId = createAssistantThreadKey(input.assistantChannel, input.assistantThreadId);
		const registry = await this.readRegistry();
		const existing = registry[sessionId];
		const runtime = await this.getRuntime(sessionId, input.modelRef);
		const session = await runtime.sessionPromise;
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Persistent assistant session did not produce a session file");
		await this.upsertRegistryEntry(sessionId, {
			sessionPath: sessionFile,
			kind: "assistant",
			origin: input.origin,
			location: this.hostRole === "remote" ? "remote" : "local",
			workspaceMode: input.workspaceMode ?? "none",
			assistantChannel: input.assistantChannel,
			assistantThreadId: input.assistantThreadId,
			title: input.title,
			modelRef: input.modelRef,
		});
		const metadata = await this.getMetadata(sessionId, input.modelRef);
		if (!metadata) throw new Error(`Failed to resolve session metadata for ${sessionId}`);
		return {
			sessionId,
			created: !existing,
			sessionFile,
			metadata,
		};
	}

	async resetThread(threadKey: string): Promise<void> {
		this.runtimes.delete(threadKey);
		const registry = await this.readRegistry();
		const entry = registry[threadKey];
		if (entry?.sessionPath && existsSync(entry.sessionPath)) {
			await rm(entry.sessionPath, { force: true });
		}
		delete registry[threadKey];
		await this.writeRegistry(registry);
	}

	async resetSession(sessionId: string): Promise<void> {
		await this.resetThread(sessionId);
	}

	async getStatus(sessionId: string, modelRef?: string): Promise<HostedSessionStatus | undefined> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		const hasRuntime = this.runtimes.has(sessionId);
		if (!entry?.sessionPath || (!existsSync(entry.sessionPath) && !hasRuntime)) return undefined;
		const runtime = modelRef ? await this.getRuntime(sessionId, modelRef) : this.runtimes.get(sessionId);
		let messageCount: number | undefined;
		if (runtime) {
			const session = await runtime.sessionPromise;
			messageCount = session.messages.length;
		}
		return this.toStatus(sessionId, entry, runtime, messageCount);
	}

	async getSnapshot(sessionId: string, modelRef?: string, limit = 20): Promise<HostedSessionSnapshot | undefined> {
		const metadata = await this.getMetadata(sessionId, modelRef);
		if (!metadata) return undefined;
		const runtime = modelRef ? await this.getRuntime(sessionId, modelRef) : this.runtimes.get(sessionId);
		let messages: HostedSessionSnapshot["messages"] = [];
		if (runtime) {
			const session = await runtime.sessionPromise;
			messages = (session.messages as any[])
				.slice(-Math.max(1, limit))
				.map((message) => ({
					role: String(message?.role ?? message?.type ?? "unknown"),
					text: extractTextFromSessionMessage(message),
				}));
		}
		const status = await this.getStatus(sessionId, modelRef);
		if (!status) return undefined;
		return { metadata, status, messages };
	}

	async subscribe(sessionId: string, listener: HostedSessionListener, modelRef?: string): Promise<Unsubscribe> {
		if (!(await this.hasStoredSession(sessionId))) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		if (modelRef) {
			await this.getRuntime(sessionId, modelRef);
		}
		const listeners = this.listeners.get(sessionId) ?? new Set<HostedSessionListener>();
		listeners.add(listener);
		this.listeners.set(sessionId, listeners);
		const snapshot = await this.getSnapshot(sessionId, modelRef);
		if (snapshot) {
			await listener({ type: "snapshot", session: snapshot });
			await listener({ type: "status", status: snapshot.status });
		}
		return () => {
			const current = this.listeners.get(sessionId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(sessionId);
		};
	}

	async interrupt(sessionId: string, modelRef?: string): Promise<void> {
		const runtime = modelRef ? await this.getRuntime(sessionId, modelRef) : this.runtimes.get(sessionId);
		if (!runtime) return;
		runtime.runState = "aborting";
		await this.updateRegistryState(sessionId, { runState: runtime.runState, updatedAt: new Date().toISOString() });
		await this.emitStatus(sessionId, modelRef);
		const session = await runtime.sessionPromise;
		await session.abort();
		runtime.runState = "idle";
		await this.updateRegistryState(sessionId, { runState: runtime.runState, updatedAt: new Date().toISOString() });
		await this.emitStatus(sessionId, modelRef);
	}

	async getThreadStatus(threadKey: string, modelRef: string): Promise<AssistantThreadStatus> {
		const status = await this.getStatus(threadKey, modelRef);
		if (!status) return { threadKey, exists: false, loaded: this.runtimes.has(threadKey) };
		return {
			threadKey,
			exists: true,
			sessionPath: status.sessionPath,
			updatedAt: status.updatedAt,
			loaded: Boolean(status.loaded),
			messageCount: status.messageCount,
			sessionId: status.sessionId,
			createdAt: status.createdAt,
			runState: status.runState,
			queueDepth: status.queueDepth,
			lastError: status.lastError,
			assistantChannel: status.assistantChannel,
			assistantThreadId: status.assistantThreadId,
		};
	}

	async getThreadSnapshot(threadKey: string, modelRef: string, limit = 20): Promise<AssistantThreadSnapshot> {
		const snapshot = await this.getSnapshot(threadKey, modelRef, limit);
		if (!snapshot) return { threadKey, exists: false, loaded: this.runtimes.has(threadKey) };
		return {
			threadKey,
			exists: true,
			sessionPath: snapshot.status.sessionPath,
			updatedAt: snapshot.status.updatedAt,
			loaded: Boolean(snapshot.status.loaded),
			messageCount: snapshot.status.messageCount,
			sessionId: snapshot.status.sessionId,
			createdAt: snapshot.status.createdAt,
			runState: snapshot.status.runState,
			queueDepth: snapshot.status.queueDepth,
			lastError: snapshot.status.lastError,
			assistantChannel: snapshot.status.assistantChannel,
			assistantThreadId: snapshot.status.assistantThreadId,
			messages: snapshot.messages,
		};
	}

	async promptSession(
		sessionId: string,
		input: { text: string; modelRef: string },
		onToolEvent?: (event: AssistantToolEvent) => void,
	): Promise<{ accepted: AcceptedMessage; result: PromptAssistantSessionResult }> {
		await this.ensurePromptableSession(sessionId, input.modelRef);
		const runtime = await this.getRuntime(sessionId, input.modelRef);
		const queued = runtime.queueDepth > 0 || runtime.runState === "running";
		runtime.queueDepth += 1;
		const accepted: AcceptedMessage = {
			sessionId,
			accepted: true,
			queued,
			runState: queued ? "running" : runtime.runState,
		};
		const pending = runtime.queue.then(async () => {
			runtime.runState = "running";
			await this.updateRegistryState(sessionId, { runState: runtime.runState, lastError: undefined, updatedAt: new Date().toISOString() });
			await this.emitStatus(sessionId, input.modelRef);
			try {
				const session = await runtime.sessionPromise;
				const result = await promptAssistantSession(session, input.text, {
					onTextDelta: async (delta) => {
						await this.emit(sessionId, { type: "text_delta", delta });
					},
					onToolEvent: async (event) => {
						onToolEvent?.(event);
						if (event.type === "start") {
							await this.emit(sessionId, { type: "tool_start", toolName: event.toolName, args: event.args });
						} else {
							await this.emit(sessionId, { type: "tool_end", toolName: event.toolName, result: event.result, isError: event.isError });
						}
					},
				});
				runtime.runState = "idle";
				runtime.lastError = undefined;
				await this.updateRegistryState(sessionId, { runState: runtime.runState, lastError: undefined, updatedAt: new Date().toISOString() });
				await this.emit(sessionId, { type: "message_complete" });
				await this.emitStatus(sessionId, input.modelRef);
				return result;
			} catch (error) {
				runtime.runState = "error";
				runtime.lastError = error instanceof Error ? error.message : String(error);
				await this.updateRegistryState(sessionId, { runState: runtime.runState, lastError: runtime.lastError, updatedAt: new Date().toISOString() });
				await this.emit(sessionId, { type: "error", error: runtime.lastError });
				await this.emitStatus(sessionId, input.modelRef);
				throw error;
			} finally {
				runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
			}
		});
		runtime.queue = pending.then(() => undefined, () => undefined);
		const result = await pending;
		return { accepted, result };
	}

	async getMetadata(sessionId: string, modelRef?: string): Promise<HostedSessionMetadata | undefined> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		const hasRuntime = this.runtimes.has(sessionId);
		if (!entry?.sessionPath || (!existsSync(entry.sessionPath) && !hasRuntime)) return undefined;
		const runtime = modelRef ? await this.getRuntime(sessionId, modelRef) : this.runtimes.get(sessionId);
		const runState = runtime?.runState ?? (entry.lastError ? "error" : "idle");
		return {
			sessionId,
			kind: entry.kind ?? "assistant",
			origin: entry.origin ?? "assistant",
			location: entry.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			runState,
			createdAt: entry.createdAt ?? entry.updatedAt,
			updatedAt: entry.updatedAt,
			title: entry.title,
			workspaceMode: entry.workspaceMode ?? "none",
			cwd: this.hostCwd,
			sourceSessionPath: entry.sessionPath,
			assistantChannel: entry.assistantChannel,
			assistantThreadId: entry.assistantThreadId,
		};
	}

	private async emit(sessionId: string, event: HostedSessionEvent) {
		const listeners = this.listeners.get(sessionId);
		if (!listeners || listeners.size === 0) return;
		for (const listener of [...listeners]) {
			await listener(event);
		}
	}

	private async emitStatus(sessionId: string, modelRef?: string) {
		const status = await this.getStatus(sessionId, modelRef);
		if (!status) return;
		await this.emit(sessionId, { type: "status", status });
	}

	private async ensurePromptableSession(sessionId: string, modelRef: string) {
		if (await this.hasStoredSession(sessionId)) return;
		const parsed = parseAssistantThreadKey(sessionId);
		if (!parsed) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		await this.resolveAssistantSession({
			kind: "assistant",
			origin: "assistant",
			assistantChannel: parsed.channel,
			assistantThreadId: parsed.threadId,
			workspaceMode: "none",
			modelRef,
		});
	}

	private async loadOrCreateSession(threadKey: string, modelRef: string): Promise<AgentSession> {
		await this.ensureDirs();
		const registry = await this.readRegistry();
		const existingPath = registry[threadKey]?.sessionPath;
		if (existingPath && existsSync(existingPath)) {
			const session = await this.createSession(SessionManager.open(existingPath, this.sessionsDir, this.hostCwd), modelRef);
			await this.upsertRegistryEntry(threadKey, { sessionPath: existingPath, modelRef });
			return session;
		}

		const session = await this.createSession(SessionManager.create(this.hostCwd, this.sessionsDir), modelRef);
		if (!session.sessionFile) throw new Error("Persistent assistant session did not produce a session file");
		await this.upsertRegistryEntry(threadKey, {
			sessionPath: session.sessionFile,
			kind: "assistant",
			origin: "assistant",
			location: this.hostRole === "remote" ? "remote" : "local",
			workspaceMode: "none",
			assistantChannel: parseAssistantThreadKey(threadKey)?.channel,
			assistantThreadId: parseAssistantThreadKey(threadKey)?.threadId,
			modelRef,
		});
		return session;
	}

	private async createSession(sessionManager: SessionManager, modelRef: string): Promise<AgentSession> {
		const model = this.resolveModelRef(modelRef);
		if (!model) throw new Error(`Model not found: ${modelRef}`);
		const systemPrompt = await this.buildSystemPromptText();
		const resourceLoader = new DefaultResourceLoader({
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.hostCwd,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			model: model as any,
			resourceLoader,
			sessionManager,
			tools: this.tools as any,
		});
		return session;
	}

	private async ensureDirs() {
		await mkdir(this.sessionsDir, { recursive: true });
		await mkdir(dirname(this.registryPath), { recursive: true });
	}

	private async readRegistry(): Promise<SessionRegistry> {
		if (!existsSync(this.registryPath)) return {};
		try {
			return JSON.parse(await readFile(this.registryPath, "utf8")) as SessionRegistry;
		} catch {
			return {};
		}
	}

	private async hasStoredSession(sessionId: string): Promise<boolean> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		return Boolean(entry?.sessionPath && (existsSync(entry.sessionPath) || this.runtimes.has(sessionId)));
	}

	private async writeRegistry(registry: SessionRegistry) {
		await writeFile(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
	}

	private async upsertRegistryEntry(sessionId: string, patch: Partial<AssistantSessionRegistryEntry> & { sessionPath: string }) {
		const registry = await this.readRegistry();
		const now = new Date().toISOString();
		const current = registry[sessionId];
		registry[sessionId] = {
			sessionPath: patch.sessionPath,
			createdAt: current?.createdAt ?? patch.createdAt ?? now,
			updatedAt: patch.updatedAt ?? now,
			kind: patch.kind ?? current?.kind ?? "assistant",
			origin: patch.origin ?? current?.origin ?? "assistant",
			location: patch.location ?? current?.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			workspaceMode: patch.workspaceMode ?? current?.workspaceMode ?? "none",
			assistantChannel: patch.assistantChannel ?? current?.assistantChannel,
			assistantThreadId: patch.assistantThreadId ?? current?.assistantThreadId,
			title: patch.title ?? current?.title,
			modelRef: patch.modelRef ?? current?.modelRef,
			lastError: patch.lastError ?? current?.lastError,
		};
		await this.writeRegistry(registry);
	}

	private async updateRegistryState(sessionId: string, patch: { runState?: HostedSessionRunState; lastError?: string; updatedAt?: string }) {
		const registry = await this.readRegistry();
		const current = registry[sessionId];
		if (!current) return;
		registry[sessionId] = {
			...current,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
			lastError: patch.lastError,
		};
		await this.writeRegistry(registry);
	}

	private matchesFilter(summary: HostedSessionSummary, filter?: SessionFilter): boolean {
		if (!filter) return true;
		if (filter.kind && summary.kind !== filter.kind) return false;
		if (filter.location && summary.location !== filter.location) return false;
		if (filter.runState && summary.runState !== filter.runState) return false;
		if (filter.assistantChannel && summary.assistantChannel !== filter.assistantChannel) return false;
		if (!filter.includeArchived && summary.location === "archived") return false;
		if (!filter.query?.trim()) return true;
		const query = filter.query.trim().toLowerCase();
		return [
			summary.sessionId,
			summary.title,
			summary.assistantChannel,
			summary.assistantThreadId,
			summary.sessionPath,
		].some((value) => value?.toLowerCase().includes(query));
	}

	private toSummary(sessionId: string, entry: AssistantSessionRegistryEntry): HostedSessionSummary {
		const runtime = this.runtimes.get(sessionId);
		return {
			sessionId,
			title: entry.title,
			kind: entry.kind ?? "assistant",
			location: entry.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			runState: runtime?.runState ?? (entry.lastError ? "error" : "idle"),
			createdAt: entry.createdAt ?? entry.updatedAt,
			updatedAt: entry.updatedAt,
			cwd: this.hostCwd,
			assistantChannel: entry.assistantChannel,
			assistantThreadId: entry.assistantThreadId,
			sessionPath: entry.sessionPath,
			loaded: this.runtimes.has(sessionId),
		};
	}

	private toStatus(
		sessionId: string,
		entry: AssistantSessionRegistryEntry,
		runtime: AssistantSessionRuntime | undefined,
		messageCount?: number,
	): HostedSessionStatus {
		const summary = this.toSummary(sessionId, entry);
		return {
			...summary,
			messageCount,
			queueDepth: runtime?.queueDepth ?? 0,
			lastError: runtime?.lastError ?? entry.lastError,
		};
	}
}

function extractTextFromUnknownContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(content)) {
		const parts = content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object") {
					const record = part as Record<string, unknown>;
					if (typeof record.text === "string") return record.text;
					if (typeof record.content === "string") return record.content;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
		return parts || undefined;
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") {
			const trimmed = record.text.trim();
			return trimmed || undefined;
		}
		if (typeof record.content === "string") {
			const trimmed = record.content.trim();
			return trimmed || undefined;
		}
		if (Array.isArray(record.content)) return extractTextFromUnknownContent(record.content);
		if (record.message && typeof record.message === "object") {
			const nested = record.message as Record<string, unknown>;
			return extractTextFromUnknownContent(nested.content);
		}
	}
	return undefined;
}

function extractTextFromSessionMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	return extractTextFromUnknownContent(record.content)
		?? extractTextFromUnknownContent(record.message)
		?? extractTextFromUnknownContent(record.parts);
}

export interface PromptAssistantSessionResult {
	text: string;
	streamedText: string;
	lastAssistant?: unknown;
}

export async function promptAssistantSession(
	session: AgentSession,
	prompt: string,
	callbacks?: {
		onTextDelta?: (delta: string) => void | Promise<void>;
		onToolEvent?: (event: AssistantToolEvent) => void | Promise<void>;
	},
): Promise<PromptAssistantSessionResult> {
	let text = "";

	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
			void callbacks?.onTextDelta?.(event.assistantMessageEvent.delta);
		}
		if (callbacks?.onToolEvent && event.type === "tool_execution_start") {
			void callbacks.onToolEvent({ type: "start", toolName: event.toolName, args: event.args });
		}
		if (callbacks?.onToolEvent && event.type === "tool_execution_end") {
			const resultStr =
				typeof event.result === "string"
					? event.result
					: JSON.stringify(event.result);
			void callbacks.onToolEvent({
				type: "end",
				toolName: event.toolName,
				result: resultStr ?? "",
				isError: event.isError,
			});
		}
	});

	try {
		await session.prompt(prompt);
	} finally {
		unsubscribe();
	}

	const streamed = text.trim();
	const lastAssistant = [...(session.messages as unknown[])].reverse().find((message) => {
		if (!message || typeof message !== "object") return false;
		const record = message as Record<string, unknown>;
		return record.role === "assistant" || record.type === "assistant";
	});
	return {
		text: streamed || extractTextFromSessionMessage(lastAssistant) || "",
		streamedText: streamed,
		lastAssistant,
	};
}

export function createAssistantThreadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

export function parseAssistantThreadKey(threadKey: string): { channel: AssistantChannel; threadId: string } | undefined {
	const idx = threadKey.indexOf(":");
	if (idx <= 0 || idx === threadKey.length - 1) return undefined;
	const channel = threadKey.slice(0, idx) as AssistantChannel;
	const threadId = threadKey.slice(idx + 1);
	if (channel !== "telegram" && channel !== "web" && channel !== "internal") return undefined;
	return { channel, threadId };
}
