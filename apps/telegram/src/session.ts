import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { buildSystemPrompt, parseModelRef, type TelegramAppConfig } from "./config.js";

export type ChatRuntime = {
	sessionPromise: Promise<AgentSession>;
	queue: Promise<void>;
};

export const chats = new Map<string, ChatRuntime>();

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

let activeAlias = "";
let activeRef = "";

export function setActiveModel(alias: string, ref: string): void {
	activeAlias = alias;
	activeRef = ref;
}

export function getActiveModel(): { alias: string; ref: string } {
	return { alias: activeAlias, ref: activeRef };
}

function resolveModel(ref: string) {
	const parsed = parseModelRef(ref);
	if (!parsed) throw new Error(`Invalid model ref: ${ref}`);
	const model = modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) throw new Error(`Model not found: ${ref}`);
	return model;
}

async function createChatSession(config: TelegramAppConfig): Promise<AgentSession> {
	const model = resolveModel(activeRef);
	const systemPrompt = await buildSystemPrompt(config);

	const resourceLoader = new DefaultResourceLoader({
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		authStorage,
		modelRegistry,
		model,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		tools: [],
	});

	return session;
}

export function getChatRuntime(chatId: string, config: TelegramAppConfig): ChatRuntime {
	let runtime = chats.get(chatId);
	if (!runtime) {
		runtime = {
			sessionPromise: createChatSession(config),
			queue: Promise.resolve(),
		};
		chats.set(chatId, runtime);
	}
	return runtime;
}

export type ToolEvent =
	| { type: "start"; toolName: string; args: unknown }
	| { type: "end"; toolName: string; result: string; isError: boolean };

export async function askPi(
	session: AgentSession,
	prompt: string,
	onToolEvent?: (event: ToolEvent) => void,
): Promise<string> {
	let text = "";

	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
		if (onToolEvent && event.type === "tool_execution_start") {
			onToolEvent({ type: "start", toolName: event.toolName, args: event.args });
		}
		if (onToolEvent && event.type === "tool_execution_end") {
			const resultStr =
				typeof event.result === "string"
					? event.result
					: JSON.stringify(event.result);
			onToolEvent({
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

	return text.trim();
}
