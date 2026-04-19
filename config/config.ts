import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BUILT_IN_MODES, DEFAULT_CONFIG } from "./defaults.js";
import type {
	MagpieAuthConfig,
	MagpieConfig,
	ModeConfig,
	PersonalAssistantAuthConfig,
	PersonalAssistantConfig,
	PromptConfig,
	ResolvedMode,
	TelegramConfig,
	RemoteConfig,
	WebUiConfig,
	ResolvedSubagentModel,
	SubagentModelRef,
} from "./types.js";
import type { SubagentRole } from "../subagents/types.js";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
	if (Array.isArray(base)) {
		return (Array.isArray(override) ? override : base) as T;
	}
	if (!isObject(base) || !isObject(override)) {
		return (override ?? base) as T;
	}
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		if (Array.isArray(value)) result[key] = [...value];
		else if (isObject(current) && isObject(value)) result[key] = deepMerge(current, value);
		else result[key] = value;
	}
	return result as T;
}

export function getGlobalConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "magpie.json");
}

export function getProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi/magpie.json");
}

export function getGlobalAuthPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "magpie.auth.json");
}

export function getProjectAuthPath(cwd: string): string {
	return resolve(cwd, ".pi/magpie.auth.json");
}

async function readJson(path: string): Promise<any | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function loadLegacyConfig(cwd: string): Promise<Partial<MagpieConfig>> {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	const scopePairs = [
		{
			modes: resolve(baseDir, "custom-modes.json"),
			plan: resolve(baseDir, "plan-mode.json"),
			handoff: resolve(baseDir, "handoff.json"),
		},
		{
			modes: resolve(cwd, ".pi/custom-modes.json"),
			plan: resolve(cwd, ".pi/plan-mode.json"),
			handoff: resolve(cwd, ".pi/handoff.json"),
		},
	] as const;

	let config: Partial<MagpieConfig> = {};
	for (const paths of scopePairs) {
		const modesJson = existsSync(paths.modes) ? await readJson(paths.modes) : undefined;
		if (modesJson) {
			config = deepMerge(config, {
				aliases: modesJson.aliases,
				modes: modesJson.modes,
			});
		}
		const planJson = existsSync(paths.plan) ? await readJson(paths.plan) : undefined;
		if (planJson?.subagentModels) {
			config = deepMerge(config, {
				subagents: {
					default: planJson.subagentModels.default,
					plan: {
						explore: planJson.subagentModels.explore,
						design: planJson.subagentModels.design,
						risk: planJson.subagentModels.risk,
						custom: planJson.subagentModels.custom,
					},
				},
			});
		}
		const handoffJson = existsSync(paths.handoff) ? await readJson(paths.handoff) : undefined;
		if (handoffJson) {
			config = deepMerge(config, {
				subagents: {
					handoff: handoffJson.model,
				},
			});
			if (handoffJson.modeModels?.plan) {
				config = deepMerge(config, {
					subagents: {
						handoff: handoffJson.modeModels.plan,
					},
					handoff: { defaultMode: "plan" },
				});
			}
		}
	}
	return config;
}

export async function loadConfig(cwd: string): Promise<MagpieConfig> {
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const globalConfig = existsSync(globalPath) ? await readJson(globalPath) : undefined;
	const projectConfig = existsSync(projectPath) ? await readJson(projectPath) : undefined;

	if (!globalConfig && !projectConfig) {
		const legacy = await loadLegacyConfig(cwd);
		return deepMerge(DEFAULT_CONFIG, legacy);
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export async function loadAuthConfig(cwd: string): Promise<MagpieAuthConfig> {
	const globalPath = getGlobalAuthPath();
	const projectPath = getProjectAuthPath(cwd);
	const globalAuth = existsSync(globalPath) ? await readJson(globalPath) : undefined;
	const projectAuth = existsSync(projectPath) ? await readJson(projectPath) : undefined;
	return deepMerge(deepMerge({} as MagpieAuthConfig, globalAuth), projectAuth);
}

function normalizeModeConfig(name: string, mode: ModeConfig | undefined): ResolvedMode | undefined {
	if (!mode) return undefined;
	return {
		name,
		...mode,
		statusLabel: mode.statusLabel ?? name,
		planBehavior: mode.planBehavior ?? "none",
	};
}

export function getMode(config: MagpieConfig, name: string): ResolvedMode | undefined {
	const normalized = name.trim().toLowerCase();
	const alias = config.aliases?.[normalized];
	const resolved = alias ?? normalized;
	if (resolved === "default" || resolved === "off" || resolved === "build") {
		return normalizeModeConfig("smart", deepMerge(BUILT_IN_MODES.smart, config.modes.smart));
	}
	const builtIn = BUILT_IN_MODES[resolved];
	const user = config.modes[resolved];
	if (!builtIn && !user) return undefined;
	return normalizeModeConfig(resolved, deepMerge(builtIn ?? {}, user ?? {}));
}

export function resolveSubagentModelRef(ref: SubagentModelRef | undefined): ResolvedSubagentModel | undefined {
	if (!ref) return undefined;
	if (typeof ref === "string") return { model: ref };
	return { model: ref.model, thinkingLevel: ref.thinkingLevel, prompt: ref.prompt };
}

export function expandHomePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return trimmed;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return trimmed;
}

export function getResearchPapersDir(config: MagpieConfig): string {
	return expandHomePath(config.research?.papersDir?.trim() || "~/magpie-papers");
}

export function getResearchResolverSubagent(config: MagpieConfig): ResolvedSubagentModel | undefined {
	return resolveSubagentModelRef(config.research?.resolverSubagent);
}

export function getStartupMode(config: MagpieConfig): string {
	const configured = config.startupMode?.trim();
	return configured ? configured : "smart";
}

export function getPersonalAssistantConfig(config: MagpieConfig): PersonalAssistantConfig | undefined {
	return config.personalAssistant;
}

export function getPersonalAssistantStorageDir(config: MagpieConfig): string {
	return expandHomePath(config.personalAssistant?.storageDir?.trim() || "~/.pi/agent/personal-assistant");
}

export function getPersonalAssistantAuth(auth: MagpieAuthConfig): PersonalAssistantAuthConfig | undefined {
	return auth.personalAssistant;
}

export function getTelegramConfig(config: MagpieConfig): TelegramConfig | undefined {
	return config.telegram;
}

export function getTelegramAuth(auth: MagpieAuthConfig): { botToken?: string } | undefined {
	return auth.telegram;
}

export function getRemoteConfig(config: MagpieConfig): RemoteConfig | undefined {
	return config.remote;
}

export function getWebUiConfig(config: MagpieConfig): WebUiConfig | undefined {
	return config.webui;
}

export function resolveModel(ctx: ExtensionContext, modelRef: string | undefined) {
	if (!modelRef?.trim()) return undefined;
	const idx = modelRef.indexOf("/");
	if (idx <= 0 || idx === modelRef.length - 1) return undefined;
	return ctx.modelRegistry.find(modelRef.slice(0, idx), modelRef.slice(idx + 1));
}

export function resolveSubagentModel(
	config: MagpieConfig,
	role: SubagentRole,
	planSubRole?: "explore" | "design" | "risk" | "custom",
	activeMode?: string,
): ResolvedSubagentModel | undefined {
	const modeOverride = activeMode ? getMode(config, activeMode)?.subagents : undefined;
	if (role === "plan") {
		return resolveSubagentModelRef(
			(planSubRole ? config.subagents.plan?.[planSubRole] : undefined) ?? config.subagents.default,
		);
	}
	if (role === "search" || role === "oracle" || role === "librarian" || role === "commit") {
		const modeRoleOverride = role === "commit" ? modeOverride?.commit : modeOverride?.[role];
		return resolveSubagentModelRef(modeRoleOverride ?? config.subagents[role] ?? config.subagents.default);
	}
	return resolveSubagentModelRef(config.subagents[role] ?? config.subagents.default);
}

export async function resolvePromptText(
	baseDir: string,
	prompt: { text?: string; file?: string } | undefined,
): Promise<string | undefined> {
	if (!prompt) return undefined;
	const parts: string[] = [];
	if (prompt.file?.trim()) {
		const raw = prompt.file.trim();
		const filePath = raw.startsWith("/") ? raw : resolve(baseDir, raw);
		try {
			parts.push((await readFile(filePath, "utf8")).trim());
		} catch {
			// ignored, /magpie-reload or editor validation can surface issues later
		}
	}
	if (prompt.text?.trim()) parts.push(prompt.text.trim());
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function getConfigBaseDir(scope: "global" | "project", cwd: string): string {
	return dirname(scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd));
}

export function getActiveConfigScope(cwd: string): "global" | "project" {
	return existsSync(getProjectConfigPath(cwd)) ? "project" : "global";
}

export async function resolveSubagentPrompt(
	config: MagpieConfig,
	cwd: string,
	role: SubagentRole,
	planSubRole?: "explore" | "design" | "risk" | "custom",
	activeMode?: string,
): Promise<{ strategy: "append" | "replace"; text: string } | undefined> {
	const resolved = resolveSubagentModel(config, role, planSubRole, activeMode);
	const prompt = resolved?.prompt;
	if (!prompt) return undefined;
	const baseDir = getConfigBaseDir(getActiveConfigScope(cwd), cwd);
	const text = await resolvePromptText(baseDir, prompt);
	if (!text?.trim()) return undefined;
	return { strategy: prompt.strategy ?? "append", text: text.trim() };
}
