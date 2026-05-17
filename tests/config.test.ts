import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	expandHomePath,
	getActiveConfigScope,
	getConfigBaseDir,
	getGlobalAuthPath,
	getGlobalConfigPath,
	getMode,
	getProjectAuthPath,
	getProjectConfigPath,
	loadAuthConfig,
	loadConfig,
	MagpieConfigParseError,
	resolveModel,
	resolvePromptText,
	resolveSubagentModel,
	resolveSubagentModelRef,
	resolveSubagentPrompt,
} from "../config/config.js";

describe("config loading and resolution", () => {
	let globalDir: string;
	let projectDir: string;

	beforeEach(async () => {
		globalDir = await mkdtemp(resolve("/tmp", "magpie-config-global-"));
		projectDir = await mkdtemp(resolve("/tmp", "magpie-config-project-"));
		process.env.PI_CODING_AGENT_DIR = globalDir;
		await mkdir(resolve(projectDir, ".pi"), { recursive: true });
	});

	test("resolves global and project config/auth paths from environment and cwd", () => {
		expect(getGlobalConfigPath()).toBe(resolve(globalDir, "magpie.json"));
		expect(getGlobalAuthPath()).toBe(resolve(globalDir, "magpie.auth.json"));
		expect(getProjectConfigPath(projectDir)).toBe(resolve(projectDir, ".pi/magpie.json"));
		expect(getProjectAuthPath(projectDir)).toBe(resolve(projectDir, ".pi/magpie.auth.json"));
	});

	test("deep-merges default, global, and project config without legacy migrations", async () => {
		await writeFile(resolve(globalDir, "magpie.json"), JSON.stringify({
			preferences: { enabled: true },
			memory: { rootDir: "~/mem" },
			modes: { custom: { skills: ["global"], tools: ["one"] } },
		}), "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.json"), JSON.stringify({
			preferences: { maxRetrieved: 7 },
			modes: { custom: { tools: ["two"], hideTools: ["web_search"] } },
		}), "utf8");

		const config = await loadConfig(projectDir);

		expect(config.preferences?.enabled).toBe(true);
		expect(config.preferences?.maxRetrieved).toBe(7);
		expect(config.memory?.rootDir).toBe("~/mem");
		expect(getMode(config, "custom")).toMatchObject({
			name: "custom",
			skills: ["global"],
			tools: ["two"],
			hideTools: ["web_search"],
		});
		expect(getMode(config, "default")).toBeUndefined();
		expect(getMode(config, "plan")?.statusLabel).toBe("plan");
	});

	test("merges auth config with project overriding global", async () => {
		await writeFile(resolve(globalDir, "magpie.auth.json"), JSON.stringify({
			telegram: { botToken: "global-token" },
			remote: { hosts: { home: { deviceToken: "global-device" } } },
		}), "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.auth.json"), JSON.stringify({ telegram: { botToken: "project-token" } }), "utf8");

		const auth = await loadAuthConfig(projectDir);
		expect(auth.telegram?.botToken).toBe("project-token");
		expect(auth.remote?.hosts?.home?.deviceToken).toBe("global-device");
	});

	test("fails loudly for invalid config or auth JSON instead of falling back to defaults", async () => {
		await writeFile(resolve(projectDir, ".pi/magpie.json"), "{ invalid", "utf8");
		await expect(loadConfig(projectDir)).rejects.toBeInstanceOf(MagpieConfigParseError);
		await writeFile(resolve(projectDir, ".pi/magpie.json"), "{}", "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.auth.json"), "{ invalid", "utf8");
		await expect(loadAuthConfig(projectDir)).rejects.toBeInstanceOf(MagpieConfigParseError);
	});

	test("resolves worker models, prompt files, and model refs", async () => {
		const promptFile = resolve(projectDir, "prompt.md");
		await writeFile(promptFile, "from file\n", "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.json"), JSON.stringify({
			commit: { model: { model: "provider/commit", thinkingLevel: "low", prompt: { file: "../prompt.md", text: "inline", strategy: "replace" } } },
		}), "utf8");
		const config = await loadConfig(projectDir);

		expect(expandHomePath("~/x")).toBe(resolve(homedir(), "x"));
		expect(getActiveConfigScope(projectDir)).toBe("project");
		expect(getConfigBaseDir("project", projectDir)).toBe(resolve(projectDir, ".pi"));
		expect(resolveSubagentModelRef({ model: "provider/x", thinkingLevel: "high" })).toEqual({ model: "provider/x", thinkingLevel: "high", prompt: undefined });
		expect(resolveSubagentModel(config, "commit")).toEqual({ model: "provider/commit", thinkingLevel: "low", prompt: { file: "../prompt.md", text: "inline", strategy: "replace" } });
		expect(await resolvePromptText(projectDir, { file: "prompt.md", text: "inline" })).toBe("from file\n\ninline");
		expect(await resolveSubagentPrompt(config, projectDir, "commit")).toEqual({ strategy: "replace", text: "from file\n\ninline" });
		expect(resolveModel({ modelRegistry: { find: (provider: string, model: string) => `${provider}:${model}` } } as any, "opencode/gpt-5-nano")).toBe("opencode:gpt-5-nano");
		expect(resolveModel({ modelRegistry: { find: (): undefined => undefined } } as any, "bad-ref")).toBeUndefined();
	});
});
