import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { extractTextFromSessionMessage } from "./session-content.js";

export type SessionToolEvent =
	| { type: "start"; toolName: string; args: unknown }
	| { type: "end"; toolName: string; result: string; isError: boolean };

export interface PromptSessionResult {
	text: string;
	streamedText: string;
	lastAssistant?: unknown;
}

export async function promptSession(
	session: AgentSession,
	prompt: string,
	callbacks?: {
		onTextDelta?: (delta: string) => void | Promise<void>;
		onToolEvent?: (event: SessionToolEvent) => void | Promise<void>;
		onAssistantMessageComplete?: (message: unknown) => void | Promise<void>;
	},
): Promise<PromptSessionResult> {
	let currentText = "";
	let lastAssistantText = "";
	let lastAssistantMessage: unknown;

	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			currentText += event.assistantMessageEvent.delta;
			void callbacks?.onTextDelta?.(event.assistantMessageEvent.delta);
			return;
		}
		if (event.type === "message_end") {
			const message = event.message as unknown as Record<string, unknown> | undefined;
			if (message?.role === "assistant" || message?.type === "assistant") {
				lastAssistantMessage = event.message;
				lastAssistantText = extractTextFromSessionMessage(event.message) || currentText.trim();
				currentText = "";
				void callbacks?.onAssistantMessageComplete?.(event.message);
			}
			return;
		}
		if (callbacks?.onToolEvent && event.type === "tool_execution_start") {
			void callbacks.onToolEvent({ type: "start", toolName: event.toolName, args: event.args });
			return;
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

	const fallbackAssistant = lastAssistantMessage ?? [...(session.messages as unknown[])].reverse().find((message) => {
		if (!message || typeof message !== "object") return false;
		const record = message as Record<string, unknown>;
		return record.role === "assistant" || record.type === "assistant";
	});
	const streamed = currentText.trim();
	const text = lastAssistantText || extractTextFromSessionMessage(fallbackAssistant) || streamed;
	return {
		text,
		streamedText: text,
		lastAssistant: fallbackAssistant,
	};
}
