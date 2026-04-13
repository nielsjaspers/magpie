import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { getConfigBaseDir, getGlobalConfigPath, getMode, getProjectConfigPath, loadConfig, resolvePromptText } from "../config/config.js";
import type { ResolvedMode } from "../config/types.js";

const MODE_STATE_TYPE = "magpie:mode-state";
const PLAN_STATE_TYPE = "magpie:plan-state";
const STATUS_KEY = "magpie-mode";
const FALLBACK_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"session_query",
	"search_subagent",
	"oracle_subagent",
	"librarian_subagent",
	"handoff",
	"save_memory",
	"recall_memories",
];

function defaultConfigText() {
	return JSON.stringify(DEFAULT_CONFIG, null, 2);
}

function normalizeModeName(input: string): string {
	const normalized = input.trim().toLowerCase();
	if (normalized === "default" || normalized === "off" || normalized === "build") return "smart";
	return normalized;
}

function getPlanEnabled(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { enabled?: boolean } }>;
	return entries.filter((entry) => entry.type === "custom" && entry.customType === PLAN_STATE_TYPE).pop()?.data?.enabled === true;
}

async function setModeProfile(pi: ExtensionAPI, ctx: ExtensionContext, mode: ResolvedMode) {
	if (mode.model) {
		const idx = mode.model.indexOf("/");
		if (idx > 0) {
			const runtimeModel = ctx.modelRegistry.find(mode.model.slice(0, idx), mode.model.slice(idx + 1));
			if (runtimeModel) await pi.setModel(runtimeModel);
		}
	}
	if (mode.thinkingLevel) pi.setThinkingLevel(mode.thinkingLevel);
}

export default function (pi: ExtensionAPI) {
	let activeMode = "smart";
	let normalTools = [...FALLBACK_TOOLS];
	let currentConfig = DEFAULT_CONFIG;

	const applyTools = (mode: ResolvedMode | undefined) => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const configured = mode?.tools?.length
			? mode.tools.flatMap((name) => (name === "@default" ? normalTools : [name]))
			: normalTools;
		pi.setActiveTools(Array.from(new Set(configured)).filter((tool) => available.has(tool)));
	};

	const persistMode = () => {
		pi.appendEntry(MODE_STATE_TYPE, { activeMode });
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const mode = getMode(currentConfig, activeMode);
		ctx.ui.setStatus(STATUS_KEY, mode ? ctx.ui.theme.fg("accent", mode.statusLabel) : undefined);
	};

	const reload = async (ctx: ExtensionContext) => {
		currentConfig = await loadConfig(ctx.cwd);
	};

	const setMode = async (
		ctx: ExtensionContext,
		rawMode: string,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<boolean> => {
		const normalized = normalizeModeName(rawMode);
		const mode = getMode(currentConfig, normalized);
		if (!mode) {
			ctx.ui.notify(`Unknown mode: ${rawMode}`, "error");
			return false;
		}
		activeMode = mode.name;
		applyTools(mode);
		await setModeProfile(pi, ctx, mode);
		updateStatus(ctx);
		if (options?.persist !== false) persistMode();
		if (mode.planBehavior === "enter-plan") {
			pi.events.emit("magpie:plan:enable", {});
		}
		if (options?.notify !== false) ctx.ui.notify(`Mode switched to ${mode.name}`, "info");
		return true;
	};

	pi.registerCommand("mode", {
		description: "Show or switch modes. /mode, /mode <name>, /mode plan",
		handler: async (args, ctx) => {
			await reload(ctx);
			const raw = args?.trim();
			if (!raw) {
				const modes = Object.keys(currentConfig.modes).sort().join(", ");
				ctx.ui.notify(`Current mode: ${activeMode}\nAvailable: ${modes}, plan`, "info");
				return;
			}
			const rawName = raw.trim().toLowerCase();
			const requested = normalizeModeName(currentConfig.aliases?.[rawName] ?? raw.trim());
			if (requested === "plan") {
				pi.events.emit("magpie:plan:enable", {});
				ctx.ui.notify("Plan mode enabled.", "info");
				return;
			}
			if ((rawName === "default" || rawName === "off" || rawName === "build") && getPlanEnabled(ctx)) {
				pi.events.emit("magpie:plan:disable", {});
				await setMode(ctx, "smart", { notify: false });
				ctx.ui.notify("Returned to smart mode and disabled plan mode.", "info");
				return;
			}
			if (getPlanEnabled(ctx) && requested !== activeMode) {
				ctx.ui.notify("Plan mode is active. Exit plan mode before switching to another normal mode.", "warning");
				return;
			}
			await setMode(ctx, requested);
		},
	});

	pi.registerCommand("magpie-config", {
		description: "Open magpie config in editor: /magpie-config [global|project]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const scope = args?.trim().toLowerCase() === "global" ? "global" : "project";
			const path = scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(ctx.cwd);
			let current = defaultConfigText();
			try {
				current = await readFile(path, "utf8");
			} catch {
				// ignore
			}
			const edited = await ctx.ui.editor(`Edit ${scope} magpie config`, current);
			if (edited === undefined) return;
			try {
				JSON.parse(edited);
			} catch (error) {
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
			const mode = getMode(currentConfig, activeMode);
			if (mode) {
				applyTools(mode);
				updateStatus(ctx);
			}
			ctx.ui.notify("Reloaded magpie config.", "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const mode = getMode(currentConfig, activeMode);
		if (!mode) return;
		const scope = existsSync(getProjectConfigPath(ctx.cwd)) ? "project" : "global";
		const baseDir = getConfigBaseDir(scope, ctx.cwd);
		const promptText = await resolvePromptText(baseDir, mode.prompt);
		const modePrompt = promptText?.trim();
		const subagentHint = "Available subagent tools: search_subagent (fast codebase retrieval), oracle_subagent (complex reasoning), librarian_subagent (external research and historical context). Use these tools when the task would benefit from delegated investigation.";
		let systemPrompt = event.systemPrompt;
		if (modePrompt) {
			systemPrompt = mode.prompt?.strategy === "replace" ? modePrompt : `${systemPrompt}\n\n${modePrompt}`;
		}
		systemPrompt = `${systemPrompt}\n\n${subagentHint}`;
		return {
			systemPrompt,
			message: {
				customType: "magpie:mode-context",
				content: `[MODE: ${mode.name}]`,
				display: false,
				details: { mode: mode.name },
			},
		};
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message: any) => message.customType !== "magpie:mode-context" || message.details?.mode === activeMode),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await reload(ctx);
		normalTools = Array.from(
			new Set([
				...pi.getActiveTools().filter((name) => !["plan_subagent", "user_question", "plan_exit"].includes(name)),
				...FALLBACK_TOOLS,
			]),
		);
		const state = (ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { activeMode?: string } }>)
			.filter((entry) => entry.type === "custom" && entry.customType === MODE_STATE_TYPE)
			.pop();
		activeMode = normalizeModeName(state?.data?.activeMode ?? "smart");
		const mode = getMode(currentConfig, activeMode) ?? getMode(currentConfig, "smart");
		if (mode) {
			activeMode = mode.name;
			applyTools(mode);
			await setModeProfile(pi, ctx, mode);
		}
		updateStatus(ctx);
	});

	pi.events.on("magpie:handoff:set-mode", async (payload: { mode?: "plan" | "default" } | undefined) => {
		if (!payload?.mode) return;
		if (payload.mode === "plan") pi.events.emit("magpie:plan:enable", {});
		if (payload.mode === "default") pi.events.emit("magpie:plan:disable", {});
	});
}
