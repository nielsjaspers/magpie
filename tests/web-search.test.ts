import { describe, expect, test } from "bun:test";
import { buildWebSearchCommand } from "../web/web-search.js";

describe("web_search command construction", () => {
	test("keeps user query as a single argv value", () => {
		const query = 'latest news "$(touch /tmp/pwned)" `uname` $HOME';
		const command = buildWebSearchCommand(query, "opencode/test-model");

		expect(command.command).toBe("env");
		expect(command.args).toEqual([
			"OPENCODE_ENABLE_EXA=1",
			"opencode",
			"run",
			query,
			"--model",
			"opencode/test-model",
		]);
	});
});
