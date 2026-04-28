import { describe, expect, test } from "bun:test";
import { createBuiltInToolsForNames, resolveToolsForNames } from "../runtime/sdk-tools.js";

describe("SDK built-in tool factory", () => {
	test("creates cwd-bound built-in tool instances in requested order", () => {
		const tools = createBuiltInToolsForNames("/tmp/project", ["read", "bash", "grep"]);

		expect(tools).toHaveLength(3);
		expect(tools.map((tool: any) => tool.name)).toEqual(["read", "bash", "grep"]);
	});

	test("rejects unknown tool names instead of passing strings into Pi SDK", () => {
		expect(() => createBuiltInToolsForNames("/tmp/project", ["read", "unknown"])).toThrow("Unknown built-in Pi tool: unknown");
	});

	test("resolves mixed built-in and extension tools without passing string names", () => {
		const readMemoryTool = { name: "read_memory" };
		const tools = resolveToolsForNames("/tmp/project", ["read", "read_memory"], [readMemoryTool]);

		expect(tools).toHaveLength(2);
		expect((tools[0] as any).name).toBe("read");
		expect(tools[1]).toBe(readMemoryTool);
	});

	test("rejects requested tools missing from built-ins and the extension registry", () => {
		expect(() => resolveToolsForNames("/tmp/project", ["read_memory"], [])).toThrow("Unknown Pi tool requested: read_memory");
	});
});
