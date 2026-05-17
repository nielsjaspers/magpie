import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	WorkerModelRef,
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

export class MagpieConfigParseError extends Error {
	readonly path: string;
	readonly cause: unknown;

	constructor(path: string, cause: unknown) {
		super(`Failed to parse Magpie config JSON at ${path}. Repair the file or move it aside before retrying.`);
		this.name = "MagpieConfigParseError";
		this.path = path;
		this.cause = cause;
	}
}

async function readJson(path: string): Promise<any> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new MagpieConfigParseError(path, error);
	}
}

export async function loadConfig(cwd: string): Promise<MagpieConfig> {
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const globalConfig = existsSync(globalPath) ? await readJson(globalPath) : undefined;
	const projectConfig = existsSync(projectPath) ? await readJson(projectPath) : undefined;
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
	return { name, ...mode };
}

function isModeConfig(mode: unknown): mode is ModeConfig {
	return isObject(mode);
}

export function getConfiguredModeNames(config: MagpieConfig): string[] {
	return Object.entries(config.modes ?? {})
		.filter(([, mode]) => isModeConfig(mode))
		.map(([name]) => name);
}

export function normalizeModeName(input: string): string {
	const normalized = input.trim().toLowerCase();
	if (!normalized || normalized === "off" || normalized === "build") return "default";
	return normalized;
}

export function getMode(config: MagpieConfig, name: string): ResolvedMode | undefined {
	const normalized = normalizeModeName(name);
	if (normalized === "default") return undefined;
	const builtIn = BUILT_IN_MODES[normalized];
	const user = config.modes?.[normalized];
	const currentUser = isModeConfig(user) ? user : undefined;
	if (!builtIn && !currentUser) return undefined;
	return normalizeModeConfig(normalized, deepMerge(builtIn ?? {}, currentUser ?? {}));
}

export function resolveSubagentModelRef(ref: WorkerModelRef | undefined): ResolvedSubagentModel | undefined {
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

export function getStartupMode(_config: MagpieConfig): string {
	return "default";
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
): ResolvedSubagentModel | undefined {
	if (role === "handoff") return resolveSubagentModelRef(config.handoff?.model);
	if (role === "session") return resolveSubagentModelRef(config.sessions?.model);
	if (role === "commit") return resolveSubagentModelRef(config.commit?.model);
	if (role === "memory") return resolveSubagentModelRef(config.memory?.model);
	if (role === "schedule") return resolveSubagentModelRef(config.schedule?.model);
	if (role === "custom") return resolveSubagentModelRef(config.btw?.model ?? config.delegate);
	return resolveSubagentModelRef(config.delegate);
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
): Promise<{ strategy: "append" | "replace"; text: string } | undefined> {
	const resolved = resolveSubagentModel(config, role);
	const prompt = resolved?.prompt;
	if (!prompt) return undefined;
	const baseDir = getConfigBaseDir(getActiveConfigScope(cwd), cwd);
	const text = await resolvePromptText(baseDir, prompt);
	if (!text?.trim()) return undefined;
	return { strategy: prompt.strategy ?? "append", text: text.trim() };
}
