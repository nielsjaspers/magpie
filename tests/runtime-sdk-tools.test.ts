import { describe, expect, test } from "bun:test";
import { createBuiltInToolsForNames } from "../runtime/sdk-tools.js";

describe("SDK built-in tool factory", () => {
	test("creates cwd-bound built-in tool instances in requested order", () => {
		const tools = createBuiltInToolsForNames("/tmp/project", ["read", "bash", "grep"]);

		expect(tools).toHaveLength(3);
		expect(tools.map((tool: any) => tool.name)).toEqual(["read", "bash", "grep"]);
	});

	test("rejects unknown tool names instead of passing strings into Pi SDK", () => {
		expect(() => createBuiltInToolsForNames("/tmp/project", ["read", "unknown"])).toThrow("Unknown built-in Pi tool: unknown");
	});
});
