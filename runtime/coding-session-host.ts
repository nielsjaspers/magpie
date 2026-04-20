import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
	CreateSessionInput,
	ExportedSessionBundle,
	HostedSessionEvent,
	HostedSessionListener,
	HostedSessionMetadata,
	HostedSessionRunState,
	HostedSessionSnapshot,
	HostedSessionStatus,
	HostedSessionSummary,
	ImportSessionInput,
	SendMessageInput,
	SessionFilter,
	SessionHost,
	Unsubscribe,
} from "./session-host-types.js";
import { createWorkspaceArchiveFromDir, ensureCleanDirectory, extractWorkspaceArchiveToDir } from "../remote/workspace.js";

interface CodingSessionRegistryEntry {
	sessionPath: string;
	createdAt?: string;
	updatedAt: string;
	kind?: "coding";
	origin?: HostedSessionMetadata["origin"];
	location?: HostedSessionMetadata["location"];
	workspaceMode?: HostedSessionMetadata["workspaceMode"];
	title?: string;
	cwd?: string;
	workspaceDir?: string;
	originalCwd?: string;
	modelRef?: string;
	lastError?: string;
}

type CodingSessionRegistry = Record<string, CodingSessionRegistryEntry>;

interface CodingSessionRuntime {
	sessionPromise: Promise<AgentSession>;
	queue: Promise<void>;
	runState: HostedSessionRunState;
	queueDepth: number;
	lastError?: string;
	cwd: string;
	modelRef: string;
}

export interface CodingSessionHostConfig {
	hostCwd: string;
	storageDir: string;
	workspaceRootDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	resolveModel: (ref: string) => unknown;
	buildSystemPrompt?: () => Promise<string>;
	hostId?: string;
	hostRole?: "local" | "remote";
	workspaceArchiveExcludes?: string[];
	maxWorkspaceArchiveBytes?: number;
}

export class CodingSessionHost implements SessionHost {
	readonly hostId: string;
	readonly hostRole: "local" | "remote";

	private readonly hostCwd: string;
	private readonly sessionsDir: string;
	private readonly registryPath: string;
	private readonly workspaceRootDir: string;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly resolveModelRef: (ref: string) => unknown;
	private readonly buildSystemPromptText?: () => Promise<string>;
	private readonly workspaceArchiveExcludes: string[];
	private readonly maxWorkspaceArchiveBytes?: number;
	private readonly runtimes = new Map<string, CodingSessionRuntime>();
	private readonly listeners = new Map<string, Set<HostedSessionListener>>();

	constructor(config: CodingSessionHostConfig) {
		this.hostId = config.hostId ?? "magpie-coding-host";
		this.hostRole = config.hostRole ?? "remote";
		this.hostCwd = config.hostCwd;
		this.sessionsDir = resolve(config.storageDir, "sessions");
		this.registryPath = resolve(config.storageDir, "coding-sessions.json");
		this.workspaceRootDir = config.workspaceRootDir;
		this.authStorage = config.authStorage;
		this.modelRegistry = config.modelRegistry;
		this.resolveModelRef = config.resolveModel;
		this.buildSystemPromptText = config.buildSystemPrompt;
		this.workspaceArchiveExcludes = config.workspaceArchiveExcludes ?? [];
		this.maxWorkspaceArchiveBytes = config.maxWorkspaceArchiveBytes;
	}

	async createSession(input: CreateSessionInput): Promise<HostedSessionMetadata> {
		if (input.kind !== "coding") throw new Error(`Unsupported session kind for coding host: ${input.kind}`);
		const sessionId = randomUUID();
		const modelRef = input.modelRef?.trim();
		if (!modelRef) throw new Error("modelRef is required to create a coding session");
		const cwd = input.cwd?.trim() || await this.ensureWorkspaceDirectory(sessionId);
		const runtime = await this.getRuntime(sessionId, cwd, modelRef);
		const session = await runtime.sessionPromise;
		if (!session.sessionFile) throw new Error("Persistent coding session did not produce a session file");
		await this.upsertRegistryEntry(sessionId, {
			sessionPath: session.sessionFile,
			origin: input.origin,
			location: this.hostRole === "remote" ? "remote" : "local",
			workspaceMode: input.workspaceMode ?? "attached",
			title: input.title,
			cwd,
			workspaceDir: cwd,
			modelRef,
		});
		const metadata = await this.getMetadata(sessionId, modelRef);
		if (!metadata) throw new Error(`Failed to create coding session metadata for ${sessionId}`);
		return metadata;
	}

	async importSession(input: ImportSessionInput): Promise<HostedSessionMetadata> {
		const { bundle } = input;
		if (bundle.metadata.kind !== "coding") throw new Error(`Unsupported imported session kind for coding host: ${bundle.metadata.kind}`);
		await this.ensureDirs();
		const sessionId = bundle.metadata.sessionId || randomUUID();
		const sessionPath = resolve(this.sessionsDir, `${sanitizeSessionIdForFilename(sessionId)}.jsonl`);
		const targetWorkspace = input.targetCwd?.trim() || await this.ensureWorkspaceDirectory(sessionId);
		if (bundle.workspace?.archive) {
			await ensureCleanDirectory(targetWorkspace);
			await extractWorkspaceArchiveToDir(bundle.workspace.archive, targetWorkspace);
		} else {
			await mkdir(targetWorkspace, { recursive: true });
		}
		await writeFile(sessionPath, Buffer.from(bundle.sessionJsonl), "utf8");
		this.runtimes.delete(sessionId);
		await this.upsertRegistryEntry(sessionId, {
			sessionPath,
			origin: bundle.metadata.origin,
			location: this.hostRole === "remote" ? "remote" : bundle.metadata.location,
			workspaceMode: bundle.metadata.workspaceMode ?? "attached",
			title: bundle.metadata.title,
			cwd: targetWorkspace,
			workspaceDir: targetWorkspace,
			originalCwd: bundle.metadata.cwd,
			modelRef: bundle.metadata.summary || undefined,
		});
		const metadata = await this.getMetadata(sessionId);
		if (!metadata) throw new Error(`Failed to import coding session metadata for ${sessionId}`);
		return metadata;
	}

	async exportSession(sessionId: string, modelRef?: string): Promise<ExportedSessionBundle> {
		const metadata = await this.getMetadata(sessionId, modelRef);
		if (!metadata) throw new Error(`Session not found: ${sessionId}`);
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		if (!entry?.sessionPath || !existsSync(entry.sessionPath)) throw new Error(`Session file not found for export: ${sessionId}`);
		const sessionJsonl = await readFile(entry.sessionPath);
		const workspaceCwd = entry.workspaceDir || entry.cwd;
		const workspace = workspaceCwd && existsSync(workspaceCwd)
			? {
				archive: await createWorkspaceArchiveFromDir(workspaceCwd, {
					excludes: this.workspaceArchiveExcludes,
					maxBytes: this.maxWorkspaceArchiveBytes,
				}),
				format: "tar.gz" as const,
			}
			: undefined;
		return {
			metadata: {
				...metadata,
				cwd: entry.originalCwd || metadata.cwd,
				summary: entry.modelRef || metadata.summary,
			},
			sessionJsonl,
			workspace,
		};
	}

	async sendUserMessage(sessionId: string, input: SendMessageInput): Promise<AcceptedMessage> {
		const modelRef = input.modelRef?.trim() || (await this.readRegistry())[sessionId]?.modelRef;
		if (!modelRef) throw new Error("modelRef is required to send a message");
		const runtime = await this.getRuntimeForExistingSession(sessionId, modelRef);
		const queued = runtime.queueDepth > 0 || runtime.runState === "running";
		runtime.queueDepth += 1;
		const accepted: AcceptedMessage = { sessionId, accepted: true, queued, runState: queued ? "running" : runtime.runState };
		const pending = runtime.queue.then(async () => {
			runtime.runState = "running";
			await this.persistRuntimeState(sessionId, runtime);
			await this.emitStatus(sessionId, modelRef);
			try {
				const session = await runtime.sessionPromise;
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						void this.emit(sessionId, { type: "text_delta", delta: event.assistantMessageEvent.delta });
					}
					if (event.type === "tool_execution_start") {
						void this.emit(sessionId, { type: "tool_start", toolName: event.toolName, args: event.args });
					}
					if (event.type === "tool_execution_end") {
						void this.emit(sessionId, { type: "tool_end", toolName: event.toolName, result: event.result, isError: event.isError });
					}
				});
				try {
					await session.prompt(input.text);
				} finally {
					unsubscribe();
				}
				runtime.runState = "idle";
				runtime.lastError = undefined;
				await this.persistRuntimeState(sessionId, runtime);
				await this.emit(sessionId, { type: "message_complete" });
				await this.emitStatus(sessionId, modelRef);
			} catch (error) {
				runtime.runState = "error";
				runtime.lastError = error instanceof Error ? error.message : String(error);
				await this.persistRuntimeState(sessionId, runtime);
				await this.emit(sessionId, { type: "error", error: runtime.lastError });
				await this.emitStatus(sessionId, modelRef);
				throw error;
			} finally {
				runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
			}
		});
		runtime.queue = pending.then(() => undefined, () => undefined);
		await pending;
		return accepted;
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

	async getStatus(sessionId: string, modelRef?: string): Promise<HostedSessionStatus | undefined> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		const hasRuntime = this.runtimes.has(sessionId);
		if (!entry?.sessionPath || (!existsSync(entry.sessionPath) && !hasRuntime)) return undefined;
		const resolvedModelRef = modelRef?.trim() || entry.modelRef;
		const runtime = resolvedModelRef ? await this.getRuntime(sessionId, entry.cwd || this.hostCwd, resolvedModelRef) : this.runtimes.get(sessionId);
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
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		const resolvedModelRef = modelRef?.trim() || entry?.modelRef;
		const runtime = entry && resolvedModelRef ? await this.getRuntime(sessionId, entry.cwd || this.hostCwd, resolvedModelRef) : this.runtimes.get(sessionId);
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
		const status = await this.getStatus(sessionId, resolvedModelRef);
		if (!status) return undefined;
		return { metadata, status, messages };
	}

	async subscribe(sessionId: string, listener: HostedSessionListener, modelRef?: string): Promise<Unsubscribe> {
		if (!(await this.hasStoredSession(sessionId))) throw new Error(`Session not found: ${sessionId}`);
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
		const runtime = await this.getRuntimeForExistingSession(sessionId, modelRef);
		runtime.runState = "aborting";
		await this.persistRuntimeState(sessionId, runtime);
		await this.emitStatus(sessionId, modelRef || runtime.modelRef);
		const session = await runtime.sessionPromise;
		await session.abort();
		runtime.runState = "idle";
		await this.persistRuntimeState(sessionId, runtime);
		await this.emitStatus(sessionId, modelRef || runtime.modelRef);
	}

	async archiveSession(sessionId: string): Promise<void> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		if (!entry) return;
		entry.location = "archived";
		entry.updatedAt = new Date().toISOString();
		await this.writeRegistry(registry);
		this.runtimes.delete(sessionId);
	}

	private async getMetadata(sessionId: string, modelRef?: string): Promise<HostedSessionMetadata | undefined> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		const hasRuntime = this.runtimes.has(sessionId);
		if (!entry?.sessionPath || (!existsSync(entry.sessionPath) && !hasRuntime)) return undefined;
		const resolvedModelRef = modelRef?.trim() || entry.modelRef;
		const runtime = entry && resolvedModelRef ? await this.getRuntime(sessionId, entry.cwd || this.hostCwd, resolvedModelRef) : this.runtimes.get(sessionId);
		const runState = runtime?.runState ?? (entry.lastError ? "error" : "idle");
		return {
			sessionId,
			kind: "coding",
			origin: entry.origin ?? "remote",
			location: entry.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			runState,
			createdAt: entry.createdAt ?? entry.updatedAt,
			updatedAt: entry.updatedAt,
			title: entry.title,
			workspaceMode: entry.workspaceMode ?? "attached",
			cwd: entry.cwd || this.hostCwd,
			sourceSessionPath: entry.sessionPath,
			summary: entry.modelRef,
		};
	}

	private async getRuntimeForExistingSession(sessionId: string, modelRef?: string) {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		const resolvedModelRef = modelRef?.trim() || entry.modelRef;
		if (!resolvedModelRef) throw new Error("modelRef is required for coding session runtime access");
		return await this.getRuntime(sessionId, entry.cwd || this.hostCwd, resolvedModelRef);
	}

	private async getRuntime(sessionId: string, cwd: string, modelRef: string): Promise<CodingSessionRuntime> {
		let runtime = this.runtimes.get(sessionId);
		if (!runtime) {
			runtime = {
				sessionPromise: this.loadOrCreateSession(sessionId, cwd, modelRef),
				queue: Promise.resolve(),
				runState: "idle",
				queueDepth: 0,
				cwd,
				modelRef,
			};
			this.runtimes.set(sessionId, runtime);
		}
		return runtime;
	}

	private async loadOrCreateSession(sessionId: string, cwd: string, modelRef: string): Promise<AgentSession> {
		await this.ensureDirs();
		const registry = await this.readRegistry();
		const existingPath = registry[sessionId]?.sessionPath;
		if (existingPath && existsSync(existingPath)) {
			const session = await this.instantiateAgentSession(SessionManager.open(existingPath, this.sessionsDir, cwd), modelRef, cwd);
			await this.upsertRegistryEntry(sessionId, { sessionPath: existingPath, cwd, workspaceDir: cwd, modelRef });
			return session;
		}
		const session = await this.instantiateAgentSession(SessionManager.create(cwd, this.sessionsDir), modelRef, cwd);
		if (!session.sessionFile) throw new Error("Persistent coding session did not produce a session file");
		await this.upsertRegistryEntry(sessionId, {
			sessionPath: session.sessionFile,
			origin: "remote",
			location: this.hostRole === "remote" ? "remote" : "local",
			workspaceMode: "attached",
			cwd,
			workspaceDir: cwd,
			modelRef,
		});
		return session;
	}

	private async instantiateAgentSession(sessionManager: SessionManager, modelRef: string, cwd: string): Promise<AgentSession> {
		const model = this.resolveModelRef(modelRef);
		if (!model) throw new Error(`Model not found: ${modelRef}`);
		const systemPrompt = this.buildSystemPromptText ? await this.buildSystemPromptText() : "You are a helpful coding assistant. Be concise and effective.";
		const resourceLoader = new DefaultResourceLoader({
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			model: model as any,
			resourceLoader,
			sessionManager,
		});
		return session;
	}

	private async ensureWorkspaceDirectory(sessionId: string): Promise<string> {
		const dir = resolve(this.workspaceRootDir, sanitizeSessionIdForFilename(sessionId));
		await mkdir(dir, { recursive: true });
		return dir;
	}

	private async ensureDirs() {
		await mkdir(this.sessionsDir, { recursive: true });
		await mkdir(dirname(this.registryPath), { recursive: true });
		await mkdir(this.workspaceRootDir, { recursive: true });
	}

	private async readRegistry(): Promise<CodingSessionRegistry> {
		if (!existsSync(this.registryPath)) return {};
		try {
			return JSON.parse(await readFile(this.registryPath, "utf8")) as CodingSessionRegistry;
		} catch {
			return {};
		}
	}

	private async writeRegistry(registry: CodingSessionRegistry) {
		await writeFile(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
	}

	private async upsertRegistryEntry(sessionId: string, patch: Partial<CodingSessionRegistryEntry> & { sessionPath: string }) {
		const registry = await this.readRegistry();
		const now = new Date().toISOString();
		const current = registry[sessionId];
		registry[sessionId] = {
			sessionPath: patch.sessionPath,
			createdAt: current?.createdAt ?? patch.createdAt ?? now,
			updatedAt: patch.updatedAt ?? now,
			kind: "coding",
			origin: patch.origin ?? current?.origin ?? "remote",
			location: patch.location ?? current?.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			workspaceMode: patch.workspaceMode ?? current?.workspaceMode ?? "attached",
			title: patch.title ?? current?.title,
			cwd: patch.cwd ?? current?.cwd ?? this.hostCwd,
			workspaceDir: patch.workspaceDir ?? current?.workspaceDir ?? patch.cwd ?? current?.cwd ?? this.hostCwd,
			originalCwd: patch.originalCwd ?? current?.originalCwd,
			modelRef: patch.modelRef ?? current?.modelRef,
			lastError: patch.lastError ?? current?.lastError,
		};
		await this.writeRegistry(registry);
	}

	private async hasStoredSession(sessionId: string): Promise<boolean> {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		return Boolean(entry?.sessionPath && (existsSync(entry.sessionPath) || this.runtimes.has(sessionId)));
	}

	private async persistRuntimeState(sessionId: string, runtime: CodingSessionRuntime) {
		const registry = await this.readRegistry();
		const entry = registry[sessionId];
		if (!entry) return;
		entry.updatedAt = new Date().toISOString();
		entry.lastError = runtime.lastError;
		entry.modelRef = runtime.modelRef;
		entry.cwd = runtime.cwd;
		entry.workspaceDir = runtime.cwd;
		await this.writeRegistry(registry);
	}

	private async emit(sessionId: string, event: HostedSessionEvent) {
		const listeners = this.listeners.get(sessionId);
		if (!listeners || listeners.size === 0) return;
		for (const listener of [...listeners]) await listener(event);
	}

	private async emitStatus(sessionId: string, modelRef?: string) {
		const status = await this.getStatus(sessionId, modelRef);
		if (!status) return;
		await this.emit(sessionId, { type: "status", status });
	}

	private matchesFilter(summary: HostedSessionSummary, filter?: SessionFilter): boolean {
		if (!filter) return true;
		if (filter.kind && summary.kind !== filter.kind) return false;
		if (filter.location && summary.location !== filter.location) return false;
		if (filter.runState && summary.runState !== filter.runState) return false;
		if (!filter.includeArchived && summary.location === "archived") return false;
		if (!filter.query?.trim()) return true;
		const query = filter.query.trim().toLowerCase();
		return [summary.sessionId, summary.title, summary.cwd].some((value) => value?.toLowerCase().includes(query));
	}

	private toSummary(sessionId: string, entry: CodingSessionRegistryEntry): HostedSessionSummary {
		const runtime = this.runtimes.get(sessionId);
		return {
			sessionId,
			title: entry.title,
			kind: "coding",
			location: entry.location ?? (this.hostRole === "remote" ? "remote" : "local"),
			runState: runtime?.runState ?? (entry.lastError ? "error" : "idle"),
			createdAt: entry.createdAt ?? entry.updatedAt,
			updatedAt: entry.updatedAt,
			cwd: entry.cwd ?? this.hostCwd,
			loaded: this.runtimes.has(sessionId),
		};
	}

	private toStatus(sessionId: string, entry: CodingSessionRegistryEntry, runtime: CodingSessionRuntime | undefined, messageCount?: number): HostedSessionStatus {
		const summary = this.toSummary(sessionId, entry);
		return { ...summary, messageCount, queueDepth: runtime?.queueDepth ?? 0, lastError: runtime?.lastError ?? entry.lastError };
	}
}

function sanitizeSessionIdForFilename(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function extractTextFromUnknownContent(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (Array.isArray(content)) {
		const parts = content.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const record = part as Record<string, unknown>;
				if (typeof record.text === "string") return record.text;
				if (typeof record.content === "string") return record.content;
			}
			return "";
		}).filter(Boolean).join("\n").trim();
		return parts || undefined;
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim() || undefined;
		if (typeof record.content === "string") return record.content.trim() || undefined;
		if (Array.isArray(record.content)) return extractTextFromUnknownContent(record.content);
		if (record.message && typeof record.message === "object") return extractTextFromUnknownContent((record.message as Record<string, unknown>).content);
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
