import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { cloneCodeModes, mergeMode, normalizeModeName } from "./mode-definitions.js";
import type {
	JsonModeConfig,
	JsonModesConfig,
	JsonPromptConfig,
	ModeConfigScope,
	ModeDefinition,
	PromptStrategy,
} from "./types.js";

export function getProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi/custom-modes.json");
}

export function getGlobalConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "custom-modes.json");
}

export function getConfigPath(cwd: string, scope: ModeConfigScope): string {
	return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

export function formatDisplayPath(filePath: string): string {
	return filePath.startsWith(homedir()) ? `~${filePath.slice(homedir().length)}` : filePath;
}

export function defaultConfigText(): string {
	return JSON.stringify(
		{
			aliases: {
				study: "learn",
				fast: "rush",
				careful: "deep",
			},
			modes: {
				learn: {
					statusLabel: "🎓 learn",
					tools: ["@default"],
					prompt: {
						strategy: "append",
						file: ".pi/modes/learn.md",
					},
				},
			},
		},
		null,
		2,
	);
}

async function readJsonModesConfig(path: string): Promise<JsonModesConfig | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as JsonModesConfig;
	} catch {
		return undefined;
	}
}

async function resolvePromptText(
	prompt: JsonPromptConfig | undefined,
	baseDir: string,
): Promise<{ strategy?: PromptStrategy; text?: string }> {
	if (!prompt) return {};
	const parts: string[] = [];

	if (prompt.file?.trim()) {
		const rawPath = prompt.file.trim();
		const filePath = rawPath.startsWith("/") ? rawPath : resolve(baseDir, rawPath);
		try {
			parts.push((await readFile(filePath, "utf8")).trim());
		} catch {
			// ignore missing prompt file; user can fix and /mode-reload
		}
	}
	if (prompt.text?.trim()) parts.push(prompt.text.trim());

	return {
		strategy: prompt.strategy,
		text: parts.length > 0 ? parts.join("\n\n") : undefined,
	};
}

async function materializeJsonMode(_name: string, mode: JsonModeConfig, baseDir: string): Promise<Partial<ModeDefinition>> {
	const prompt = await resolvePromptText(mode.prompt, baseDir);
	return {
		description: mode.description,
		statusLabel: mode.statusLabel,
		tools: mode.tools,
		promptStrategy: prompt.strategy,
		promptText: prompt.text,
		model: mode.model,
		thinkingLevel: mode.thinkingLevel,
		planBehavior: mode.planBehavior,
		subagents: mode.subagents,
		systemModels: mode.systemModels,
	};
}

export async function loadModeDefinitions(cwd: string): Promise<{
	definitions: Record<string, ModeDefinition>;
	aliases: Record<string, string>;
}> {
	const definitions = cloneCodeModes();
	let aliases: Record<string, string> = {};

	for (const scope of ["global", "project"] as const) {
		const configPath = getConfigPath(cwd, scope);
		if (!existsSync(configPath)) continue;
		const cfg = await readJsonModesConfig(configPath);
		if (!cfg) continue;

		const baseDir = dirname(configPath);
		aliases = {
			...aliases,
			...Object.fromEntries(
				Object.entries(cfg.aliases ?? {}).map(([k, v]) => [k.trim().toLowerCase(), normalizeModeName(v)]),
			),
		};

		for (const [rawName, modeCfg] of Object.entries(cfg.modes ?? {})) {
			const name = normalizeModeName(rawName);
			if (name === "default" || name === "plan") continue;
			const materialized = await materializeJsonMode(name, modeCfg, baseDir);
			definitions[name] = mergeMode(definitions[name], materialized, name);
		}
	}

	return { definitions, aliases };
}
