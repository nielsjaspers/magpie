import { describe, expect, test } from "bun:test";
import {
	extractTextFromSessionMessage,
	extractTextFromUnknownContent,
	sanitizeSessionIdForFilename,
} from "../runtime/session-content.js";

describe("session content helpers", () => {
	test("sanitizes session ids for filesystem paths without changing safe ids", () => {
		expect(sanitizeSessionIdForFilename("web:thread/../../x")).toBe("web-thread-..-..-x");
		expect(sanitizeSessionIdForFilename("abc.DEF_123-45")).toBe("abc.DEF_123-45");
	});

	test("extracts text from strings, parts arrays, and nested message content", () => {
		expect(extractTextFromUnknownContent("  hello  ")).toBe("hello");
		expect(extractTextFromUnknownContent([{ type: "text", text: "one" }, { content: "two" }, { ignored: true }])).toBe("one\ntwo");
		expect(extractTextFromUnknownContent({ message: { content: [{ text: "nested" }] } })).toBe("nested");
	});

	test("extracts session message text from content, message, then parts", () => {
		expect(extractTextFromSessionMessage({ role: "assistant", content: [{ text: "content" }] })).toBe("content");
		expect(extractTextFromSessionMessage({ role: "assistant", message: "message" })).toBe("message");
		expect(extractTextFromSessionMessage({ role: "assistant", parts: [{ text: "parts" }] })).toBe("parts");
		expect(extractTextFromSessionMessage(undefined)).toBeUndefined();
	});
});
