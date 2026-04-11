import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface BtwModeSelection {
	modeName: string;
	thinkingLevel?: ThinkingLevel;
	modelRef?: string;
}

interface JsonModeConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface JsonModesConfig {
	aliases?: Record<string, string>;
	modes?: Record<string, JsonModeConfig>;
}

const BUILTIN_MODE_PROFILES: Record<string, BtwModeSelection> = {
	smart: {
		modeName: "smart",
		thinkingLevel: "high",
		modelRef: "opencode-go/glm-5.1",
	},
	rush: {
		modeName: "rush",
		thinkingLevel: "medium",
		modelRef: "github-copilot/gpt-5.4-mini",
	},
	deep: {
		modeName: "deep",
		thinkingLevel: "xhigh",
		modelRef: "github-copilot/gpt-5.3-codex",
	},
	learn: {
		modeName: "learn",
	},
};

function normalizeModeName(raw: string): string {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "default" || normalized === "build" || normalized === "off") return "smart";
	return normalized;
}

function getProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi/custom-modes.json");
}

function getGlobalConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "custom-modes.json");
}

function getConfigPath(cwd: string, scope: "global" | "project"): string {
	return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

function mergeSelection(base: BtwModeSelection | undefined, override: Partial<BtwModeSelection>, modeName: string): BtwModeSelection {
	return {
		modeName,
		thinkingLevel: override.thinkingLevel ?? base?.thinkingLevel,
		modelRef: override.modelRef ?? base?.modelRef,
	};
}

async function readJsonModesConfig(path: string): Promise<JsonModesConfig | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as JsonModesConfig;
	} catch {
		return undefined;
	}
}

async function loadModeSelections(cwd: string): Promise<{
	selections: Record<string, BtwModeSelection>;
	aliases: Record<string, string>;
}> {
	const selections: Record<string, BtwModeSelection> = {
		...BUILTIN_MODE_PROFILES,
	};
	let aliases: Record<string, string> = {};

	for (const scope of ["global", "project"] as const) {
		const configPath = getConfigPath(cwd, scope);
		if (!existsSync(configPath)) continue;
		const cfg = await readJsonModesConfig(configPath);
		if (!cfg) continue;

		aliases = {
			...aliases,
			...Object.fromEntries(
				Object.entries(cfg.aliases ?? {}).map(([k, v]) => [k.trim().toLowerCase(), normalizeModeName(v)]),
			),
		};

		for (const [rawName, modeCfg] of Object.entries(cfg.modes ?? {})) {
			const name = normalizeModeName(rawName);
			if (name === "plan") continue;
			selections[name] = mergeSelection(selections[name], {
				modelRef: modeCfg.model,
				thinkingLevel: modeCfg.thinkingLevel,
			}, name);
		}
	}

	return { selections, aliases };
}

function buildModeSelectionFromName(selections: Record<string, BtwModeSelection>, aliases: Record<string, string>, rawMode: string | undefined): BtwModeSelection {
	const requested = rawMode?.trim() ? rawMode.trim() : "rush";
	const normalized = normalizeModeName(requested);
	const resolvedName = aliases[normalized] ?? normalized;

	if (resolvedName === "plan") {
		throw new Error("btw does not support plan mode. Use rush, smart, deep, or a custom mode instead.");
	}

	const selection = selections[resolvedName];
	if (!selection) {
		throw new Error(`Unknown btw mode: ${requested}`);
	}

	return selection;
}

export async function resolveBtwModeSelection(cwd: string, rawMode?: string): Promise<BtwModeSelection> {
	const { selections, aliases } = await loadModeSelections(cwd);
	return buildModeSelectionFromName(selections, aliases, rawMode);
}

export function buildBtwModeDirective(modeName: string): string {
	switch (modeName) {
		case "smart":
			return [
				"Selected btw mode: smart.",
				"Be balanced, collaborative, and correct.",
				"Use structured reasoning when the task is non-trivial, but avoid overthinking small fixes.",
			].join(" ");
		case "deep":
			return [
				"Selected btw mode: deep.",
				"Do thorough autonomous analysis before acting.",
				"Trace dependencies, surface assumptions, and validate carefully.",
			].join(" ");
		case "learn":
			return [
				"Selected btw mode: learn.",
				"Be collaborative and explanatory.",
				"Prefer practical, codebase-specific insights and clear tradeoffs.",
			].join(" ");
		case "rush":
			return [
				"Selected btw mode: rush.",
				"Optimize for speed and cost efficiency.",
				"Stay concise, skip formal planning for simple work, and move directly to the task.",
			].join(" ");
		default:
			return [
				`Selected btw mode: ${modeName}.`,
				"Follow the selected mode's configured model/thinking settings and complete the task directly.",
				"Stay focused, use the conversation context, and do not hand off.",
			].join(" ");
	}
}
