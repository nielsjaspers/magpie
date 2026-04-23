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

	test("deep-merges default, global, and project config while migrating legacy memory prefs", async () => {
		await writeFile(resolve(globalDir, "magpie.json"), JSON.stringify({
			startupMode: "rush",
			memory: { enabled: true, rootDir: "~/mem" },
			modes: { custom: { prompt: { text: "global" }, model: "provider/global" } },
		}), "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.json"), JSON.stringify({
			aliases: { c: "custom" },
			memory: { maxRetrieved: 7 },
			modes: { custom: { model: "provider/project", disableTools: ["web_search"] } },
		}), "utf8");

		const config = await loadConfig(projectDir);

		expect(config.startupMode).toBe("rush");
		expect(config.preferences?.enabled).toBe(true);
		expect(config.preferences?.maxRetrieved).toBe(7);
		expect(config.memory?.rootDir).toBe("~/mem");
		expect(getMode(config, "c")).toMatchObject({
			name: "custom",
			model: "provider/project",
			statusLabel: "custom",
			planBehavior: "none",
			disableTools: ["web_search"],
		});
	});

	test("merges auth config with project overriding global", async () => {
		await writeFile(resolve(globalDir, "magpie.auth.json"), JSON.stringify({
			telegram: { botToken: "global-token" },
			remote: { hosts: { home: { deviceToken: "global-device" } } },
		}), "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.auth.json"), JSON.stringify({
			telegram: { botToken: "project-token" },
		}), "utf8");

		const auth = await loadAuthConfig(projectDir);

		expect(auth.telegram?.botToken).toBe("project-token");
		expect(auth.remote?.hosts?.home?.deviceToken).toBe("global-device");
	});

	test("resolves modes, subagent models, prompt files, and model refs", async () => {
		const promptFile = resolve(projectDir, "prompt.md");
		await writeFile(promptFile, "from file\n", "utf8");
		await writeFile(resolve(projectDir, ".pi/magpie.json"), JSON.stringify({
			subagents: {
				default: "provider/default",
				commit: { model: "provider/commit", thinkingLevel: "low", prompt: { file: "../prompt.md", text: "inline", strategy: "replace" } },
			},
			modes: {
				review: {
					subagents: { commit: "provider/mode-commit" },
				},
			},
		}), "utf8");
		const config = await loadConfig(projectDir);

		expect(expandHomePath("~/x")).toBe(resolve(homedir(), "x"));
		expect(getActiveConfigScope(projectDir)).toBe("project");
		expect(getConfigBaseDir("project", projectDir)).toBe(resolve(projectDir, ".pi"));
		expect(resolveSubagentModelRef({ model: "provider/x", thinkingLevel: "high" })).toEqual({ model: "provider/x", thinkingLevel: "high", prompt: undefined });
		expect(resolveSubagentModel(config, "commit", undefined, "review")).toEqual({ model: "provider/mode-commit" });
		expect(await resolvePromptText(projectDir, { file: "prompt.md", text: "inline" })).toBe("from file\n\ninline");
		expect(await resolveSubagentPrompt(config, projectDir, "commit")).toEqual({ strategy: "replace", text: "from file\n\ninline" });
		expect(resolveModel({ modelRegistry: { find: (provider: string, model: string) => `${provider}:${model}` } } as any, "opencode/gpt-5-nano")).toBe("opencode:gpt-5-nano");
		expect(resolveModel({ modelRegistry: { find: () => undefined } } as any, "bad-ref")).toBeUndefined();
	});
});
