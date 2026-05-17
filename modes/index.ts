import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { getGlobalConfigPath, getMode, getProjectConfigPath, loadConfig } from "../config/config.js";
import type { MagpieConfig, ResolvedMode } from "../config/types.js";
import { MODE_STATE_TYPE, normalizeMagpieModeName } from "../pa/shared/mode.js";

const STATUS_KEY = "magpie-mode";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TOOLS = [
	"delegate",
	"get_sessions",
	"session_query",
	"commit",
	"btw",
	"web_search",
	"web_fetch",
	"handoff",
];

function defaultConfigText() {
	return JSON.stringify(DEFAULT_CONFIG, null, 2);
}

function normalizeModeName(input: string): string {
	return normalizeMagpieModeName(input);
}

async function readSkill(name: string, cwd: string): Promise<string | undefined> {
	const candidates = [
		resolve(PACKAGE_ROOT, "skills", name, "SKILL.md"),
		resolve(cwd, ".pi", "skills", name, "SKILL.md"),
	];
	for (const path of candidates) {
		try {
			const raw = await readFile(path, "utf8");
			const body = raw.startsWith("---") ? raw.replace(/^---[\s\S]*?---\s*/, "") : raw;
			return `# Skill: ${name}\n\n${body.trim()}`;
		} catch {
			// try next location
		}
	}
	return undefined;
}

async function resolveSkillPrompt(mode: ResolvedMode | undefined, cwd: string): Promise<string | undefined> {
	const skills = mode?.skills ?? [];
	if (skills.length === 0) return undefined;
	const parts = (await Promise.all(skills.map((skill) => readSkill(skill, cwd)))).filter((part): part is string => Boolean(part));
	return parts.length ? parts.join("\n\n") : undefined;
}

export default function (pi: ExtensionAPI) {
	let activeMode = "default";
	let baseTools: string[] = [];
	let currentConfig: MagpieConfig = DEFAULT_CONFIG;

	const applyTools = (mode: ResolvedMode | undefined) => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const visible = new Set([...baseTools, ...DEFAULT_TOOLS, ...(mode?.tools ?? [])]);
		for (const hidden of mode?.hideTools ?? []) visible.delete(hidden);
		pi.setActiveTools(Array.from(visible).filter((tool) => available.has(tool)));
	};

	const persistMode = () => {
		pi.appendEntry(MODE_STATE_TYPE, { activeMode });
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const mode = getMode(currentConfig, activeMode);
		ctx.ui.setStatus(STATUS_KEY, mode?.statusLabel ? ctx.ui.theme.fg("accent", mode.statusLabel) : undefined);
	};

	const reload = async (ctx: ExtensionContext) => {
		currentConfig = await loadConfig(ctx.cwd);
	};

	const setMode = async (ctx: ExtensionContext, rawMode: string, options?: { persist?: boolean; notify?: boolean }): Promise<boolean> => {
		const normalized = normalizeModeName(rawMode);
		const mode = getMode(currentConfig, normalized);
		if (!mode) {
			ctx.ui.notify(`Unknown mode: ${rawMode}`, "error");
			return false;
		}
		activeMode = mode.name;
		applyTools(mode);
		updateStatus(ctx);
		if (options?.persist !== false) persistMode();
		if (options?.notify !== false) ctx.ui.notify(`Mode switched to ${mode.name}`, "info");
		return true;
	};

	pi.registerCommand("mode", {
		description: "Show or switch modes. /mode, /mode <name>",
		handler: async (args, ctx) => {
			await reload(ctx);
			const raw = args?.trim();
			if (!raw) {
				const modes = ["default", ...Object.keys(currentConfig.modes ?? {}).sort()].join(", ");
				ctx.ui.notify(`Current mode: ${activeMode}\nAvailable: ${modes}`, "info");
				return;
			}
			await setMode(ctx, raw);
		},
	});

	pi.registerCommand("magpie-config", {
		description: "Open magpie config in editor: /magpie-config [global|project]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const scope = args?.trim().toLowerCase() === "global" ? "global" : "project";
			const path = scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(ctx.cwd);
			let current = defaultConfigText();
			try { current = await readFile(path, "utf8"); } catch {}
			const edited = await ctx.ui.editor(`Edit ${scope} magpie config`, current);
			if (edited === undefined) return;
			try { JSON.parse(edited); } catch (error) {
				ctx.ui.notify(`Invalid JSON: ${(error as Error).message}`, "error");
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, edited, "utf8");
			await ctx.reload();
			ctx.ui.notify(`Saved ${path}`, "info");
		},
	});

	pi.registerCommand("magpie-reload", {
		description: "Reload magpie config from disk",
		handler: async (_args, ctx) => {
			await reload(ctx);
			applyTools(getMode(currentConfig, activeMode));
			updateStatus(ctx);
			ctx.ui.notify("Reloaded magpie config.", "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const mode = getMode(currentConfig, activeMode);
		const skillPrompt = await resolveSkillPrompt(mode, ctx.cwd);
		return {
			systemPrompt: skillPrompt ? `${event.systemPrompt}\n\n${skillPrompt}` : event.systemPrompt,
			message: {
				customType: "magpie:mode-context",
				content: `[MODE: ${mode?.name ?? activeMode}]`,
				display: false,
				details: { mode: mode?.name ?? activeMode },
			},
		};
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message: any) => message.customType !== "magpie:mode-context" || message.details?.mode === activeMode),
	}));

	pi.on("session_start", async (_event, ctx) => {
		await reload(ctx);
		baseTools = pi.getActiveTools().filter((name) => !["plan_subagent", "user_question", "plan_exit", "search_subagent", "oracle_subagent", "librarian_subagent"].includes(name));
		await setMode(ctx, "default", { notify: false });
	});

	pi.events.on("magpie:handoff:set-mode", async (payload: unknown) => {
		const data = payload as { mode?: "plan" | "default" } | undefined;
		if (data?.mode) activeMode = data.mode;
	});
}
