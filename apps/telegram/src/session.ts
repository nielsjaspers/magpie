import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import { AssistantSessionHost, createAssistantThreadKey, type AssistantSessionRuntime } from "../../../runtime/assistant-session-host.js";
import { buildSystemPrompt, parseModelRef, type TelegramAppConfig } from "./config.js";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

let activeAlias = "";
let activeRef = "";
let hostInstance: AssistantSessionHost | null = null;

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

function getHost(config: TelegramAppConfig): AssistantSessionHost {
	if (!hostInstance) {
		hostInstance = new AssistantSessionHost({
			hostCwd: config.hostCwd,
			storageDir: config.storageDir,
			resolveModel,
			buildSystemPrompt: () => buildSystemPrompt(config),
			initialModelRef: () => activeRef,
			tools: [],
		});
	}
	return hostInstance;
}

export async function getChatRuntime(chatId: string, config: TelegramAppConfig): Promise<AssistantSessionRuntime> {
	return await getHost(config).getRuntime(createAssistantThreadKey("telegram", chatId));
}

export async function resetChatRuntime(chatId: string, config: TelegramAppConfig): Promise<void> {
	await getHost(config).resetThread(createAssistantThreadKey("telegram", chatId));
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
