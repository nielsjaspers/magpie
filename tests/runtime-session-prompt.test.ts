import { describe, expect, test } from "bun:test";
import { promptSession } from "../runtime/session-prompt.js";

type Listener = (event: any) => void;

class FakeSession {
	messages: unknown[] = [];
	promptText: string | undefined;
	unsubscribed = false;
	private listener: Listener | undefined;
	private readonly runPrompt: (session: FakeSession, prompt: string) => void | Promise<void>;

	constructor(runPrompt: (session: FakeSession, prompt: string) => void | Promise<void>) {
		this.runPrompt = runPrompt;
	}

	subscribe(listener: Listener) {
		this.listener = listener;
		return () => {
			this.unsubscribed = true;
		};
	}

	emit(event: unknown) {
		this.listener?.(event);
	}

	async prompt(prompt: string) {
		this.promptText = prompt;
		await this.runPrompt(this, prompt);
	}
}

describe("promptSession", () => {
	test("streams deltas, tool events, assistant completion, and unsubscribes", async () => {
		const assistantMessage = { role: "assistant", content: [{ text: "final answer" }] };
		const session = new FakeSession((fake) => {
			fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "final " } });
			fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
			fake.emit({ type: "tool_execution_end", toolName: "read", result: { ok: true }, isError: false });
			fake.messages.push(assistantMessage);
			fake.emit({ type: "message_end", message: assistantMessage });
		});
		const deltas: string[] = [];
		const toolEvents: unknown[] = [];
		const completed: unknown[] = [];

		const result = await promptSession(session as any, "do work", {
			onTextDelta: (delta) => deltas.push(delta),
			onToolEvent: (event) => toolEvents.push(event),
			onAssistantMessageComplete: (message) => completed.push(message),
		});

		expect(session.promptText).toBe("do work");
		expect(session.unsubscribed).toBe(true);
		expect(deltas).toEqual(["final "]);
		expect(toolEvents).toEqual([
			{ type: "start", toolName: "read", args: { path: "README.md" } },
			{ type: "end", toolName: "read", result: "{\"ok\":true}", isError: false },
		]);
		expect(completed).toEqual([assistantMessage]);
		expect(result).toEqual({ text: "final answer", streamedText: "final answer", lastAssistant: assistantMessage });
	});

	test("falls back to the last assistant message when no message_end event arrives", async () => {
		const assistantMessage = { role: "assistant", content: "from history" };
		const session = new FakeSession((fake) => {
			fake.messages.push({ role: "user", content: "question" }, assistantMessage);
		});

		const result = await promptSession(session as any, "question");

		expect(result.text).toBe("from history");
		expect(result.lastAssistant).toBe(assistantMessage);
		expect(session.unsubscribed).toBe(true);
	});

	test("unsubscribes when prompt throws", async () => {
		const session = new FakeSession(() => {
			throw new Error("boom");
		});

		await expect(promptSession(session as any, "fail")).rejects.toThrow("boom");
		expect(session.unsubscribed).toBe(true);
	});
});
