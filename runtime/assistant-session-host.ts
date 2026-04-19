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

export interface AssistantSessionHostConfig {
	hostCwd: string;
	storageDir: string;
	resolveModel: (ref: string) => unknown;
	buildSystemPrompt: () => Promise<string>;
	initialModelRef: () => string;
	tools?: unknown[];
}

export interface AssistantSessionRuntime {
	sessionPromise: Promise<AgentSession>;
	queue: Promise<void>;
	sessionFilePromise: Promise<string | undefined>;
}

type SessionRegistry = Record<string, { sessionPath: string; updatedAt: string }>;

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

export class AssistantSessionHost {
	private readonly hostCwd: string;
	private readonly storageDir: string;
	private readonly sessionsDir: string;
	private readonly registryPath: string;
	private readonly resolveModelRef: (ref: string) => unknown;
	private readonly buildSystemPromptText: () => Promise<string>;
	private readonly initialModelRef: () => string;
	private readonly tools: unknown[] | undefined;
	private readonly runtimes = new Map<string, AssistantSessionRuntime>();

	constructor(config: AssistantSessionHostConfig) {
		this.hostCwd = config.hostCwd;
		this.storageDir = config.storageDir;
		this.sessionsDir = resolve(this.storageDir, "sessions");
		this.registryPath = resolve(this.storageDir, "thread-sessions.json");
		this.resolveModelRef = config.resolveModel;
		this.buildSystemPromptText = config.buildSystemPrompt;
		this.initialModelRef = config.initialModelRef;
		this.tools = config.tools;
	}

	async getRuntime(threadKey: string): Promise<AssistantSessionRuntime> {
		let runtime = this.runtimes.get(threadKey);
		if (!runtime) {
			runtime = {
				sessionPromise: this.loadOrCreateSession(threadKey),
				queue: Promise.resolve(),
				sessionFilePromise: Promise.resolve(undefined),
			};
			runtime.sessionFilePromise = runtime.sessionPromise.then((session) => session.sessionFile);
			this.runtimes.set(threadKey, runtime);
		}
		return runtime;
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

	private async loadOrCreateSession(threadKey: string): Promise<AgentSession> {
		await this.ensureDirs();
		const registry = await this.readRegistry();
		const existingPath = registry[threadKey]?.sessionPath;
		if (existingPath && existsSync(existingPath)) {
			const session = await this.createSession(SessionManager.open(existingPath, this.sessionsDir, this.hostCwd));
			await this.touchRegistry(threadKey, existingPath, registry);
			return session;
		}

		const session = await this.createSession(SessionManager.create(this.hostCwd, this.sessionsDir));
		if (!session.sessionFile) throw new Error("Persistent assistant session did not produce a session file");
		await this.touchRegistry(threadKey, session.sessionFile, registry);
		return session;
	}

	private async createSession(sessionManager: SessionManager): Promise<AgentSession> {
		const modelRef = this.initialModelRef();
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
			authStorage,
			modelRegistry,
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

	private async writeRegistry(registry: SessionRegistry) {
		await writeFile(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
	}

	private async touchRegistry(threadKey: string, sessionPath: string, registry?: SessionRegistry) {
		const next = registry ?? await this.readRegistry();
		next[threadKey] = { sessionPath, updatedAt: new Date().toISOString() };
		await this.writeRegistry(next);
	}
}

export function createAssistantThreadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}
