import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defaultConfigText, formatDisplayPath, getConfigPath, loadModeDefinitions } from "./config.js";
import {
	MODE_STATE_CUSTOM_TYPE,
	MODE_STATUS_KEY,
	NORMAL_MODE_FALLBACK_TOOLS,
	PLAN_ONLY_TOOLS,
	PLAN_STATE_CUSTOM_TYPE,
	normalizeModeName,
} from "./mode-definitions.js";
import { buildPlanModeState, getPlanModeEnabled, getPlanModeState } from "./plan-state.js";
import type { ModeConfigScope, ModeDefinition, PersistedModesState } from "./types.js";

export default function customModesExtension(pi: ExtensionAPI): void {
	let activeMode = "default";
	let normalModeTools = [...NORMAL_MODE_FALLBACK_TOOLS];
	let definitions: Record<string, ModeDefinition> = {};
	let aliases: Record<string, string> = {};

	const applyToolSet = (desired: string[]) => {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(Array.from(new Set(desired)).filter((name) => available.has(name)));
	};

	const resolveModeTools = (modeName: string): string[] => {
		if (modeName === "default") return normalModeTools;
		const def = definitions[modeName];
		if (!def?.tools || def.tools.length === 0) return normalModeTools;

		const expanded: string[] = [];
		for (const tool of def.tools) {
			if (tool === "@default") expanded.push(...normalModeTools);
			else expanded.push(tool);
		}
		return expanded;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (activeMode === "default") {
			ctx.ui.setStatus(MODE_STATUS_KEY, undefined);
			return;
		}
		const label = definitions[activeMode]?.statusLabel ?? `⚙ ${activeMode}`;
		ctx.ui.setStatus(MODE_STATUS_KEY, ctx.ui.theme.fg("accent", label));
	};

	const persistState = () => {
		pi.appendEntry(MODE_STATE_CUSTOM_TYPE, { activeMode } satisfies PersistedModesState);
	};

	const deactivateCustomModeState = (ctx: ExtensionContext, options?: { persist?: boolean }) => {
		activeMode = "default";
		updateStatus(ctx);
		if (options?.persist !== false) persistState();
	};

	const applyMode = async (
		ctx: ExtensionContext,
		modeName: string,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<boolean> => {
		const persist = options?.persist !== false;
		const notify = options?.notify !== false;

		if (modeName !== "default" && !definitions[modeName]) {
			ctx.ui.notify(`Unknown mode: ${modeName}`, "error");
			return false;
		}

		activeMode = modeName;
		applyToolSet(resolveModeTools(activeMode));
		updateStatus(ctx);
		if (persist) persistState();

		if (notify) {
			if (modeName === "default") ctx.ui.notify("Custom mode disabled. Default/build mode active.", "info");
			else ctx.ui.notify(`Mode switched to: ${modeName}`, "info");
		}
		return true;
	};

	const listModes = (): string[] => {
		const custom = Object.keys(definitions)
			.filter((name) => name !== "default" && name !== "plan")
			.sort();
		return ["default", "build", "plan", ...custom];
	};

	const resolveModeArg = (rawArg: string): string => {
		const normalized = normalizeModeName(rawArg);
		return aliases[normalized] ?? normalized;
	};

	const reloadConfig = async (ctx: ExtensionContext): Promise<void> => {
		const loaded = await loadModeDefinitions(ctx.cwd);
		definitions = loaded.definitions;
		aliases = loaded.aliases;
	};

	pi.registerCommand("mode", {
		description: "Switch mode: /mode <default|build|learn|plan>",
		getArgumentCompletions: (prefix: string) => {
			const p = (prefix ?? "").trim().toLowerCase();
			const options = listModes().map((name) => ({ value: name, label: name }));
			const filtered = options.filter((o) => o.value.startsWith(p));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await reloadConfig(ctx);
			const raw = args?.trim();
			if (!raw) {
				ctx.ui.notify(`Current mode: ${activeMode}\nAvailable: ${listModes().join(", ")}`, "info");
				return;
			}

			const requested = resolveModeArg(raw.split(/\s+/)[0] ?? raw);

			if (requested === "plan") {
				if (activeMode !== "default") {
					if (getPlanModeEnabled(ctx)) deactivateCustomModeState(ctx);
					else await applyMode(ctx, "default", { notify: false });
				}
				if (getPlanModeEnabled(ctx)) {
					ctx.ui.notify("Plan mode is already active.", "info");
					return;
				}

				const currentPlanState = getPlanModeState(ctx);
				pi.appendEntry(PLAN_STATE_CUSTOM_TYPE, buildPlanModeState(currentPlanState, true));
				ctx.ui.notify("Starting plan mode...", "info");
				await ctx.reload();
				return;
			}

			if (requested === "default") {
				if (getPlanModeEnabled(ctx)) {
					if (activeMode !== "default") deactivateCustomModeState(ctx);
					const currentPlanState = getPlanModeState(ctx);
					pi.appendEntry(PLAN_STATE_CUSTOM_TYPE, buildPlanModeState(currentPlanState, false));
					ctx.ui.notify("Stopping plan mode...", "info");
					await ctx.reload();
					return;
				}
				await applyMode(ctx, "default", { notify: true });
				return;
			}

			if (getPlanModeEnabled(ctx)) {
				ctx.ui.notify("Plan mode is active. Run /mode default (or /plan) first.", "warning");
				return;
			}

			if (!definitions[requested]) {
				ctx.ui.notify(`Unknown mode: ${requested}`, "error");
				return;
			}

			await applyMode(ctx, requested, { notify: true });
		},
	});

	pi.registerCommand("mode-config", {
		description: "Edit custom modes config: /mode-config [global|project]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/mode-config requires interactive UI.", "warning");
				return;
			}

			const scope: ModeConfigScope = args?.trim().toLowerCase() === "global" ? "global" : "project";
			const path = getConfigPath(ctx.cwd, scope);
			let current = defaultConfigText();
			try {
				current = await readFile(path, "utf8");
			} catch {
				// use defaults
			}

			const edited = await ctx.ui.editor(`Edit ${scope} mode config: ${formatDisplayPath(path)}`, current);
			if (!edited) return;

			try {
				JSON.parse(edited);
			} catch (error) {
				ctx.ui.notify(`Invalid JSON: ${(error as Error).message}`, "error");
				return;
			}

			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, edited, "utf8");
			await reloadConfig(ctx);

			if (activeMode !== "default" && !definitions[activeMode]) {
				await applyMode(ctx, "default", { notify: false });
			}

			ctx.ui.notify(`Saved ${formatDisplayPath(path)}`, "success");
		},
	});

	pi.registerCommand("mode-reload", {
		description: "Reload custom mode definitions from config files",
		handler: async (_args, ctx) => {
			await reloadConfig(ctx);
			if (activeMode !== "default" && !definitions[activeMode]) {
				await applyMode(ctx, "default", { notify: false });
				ctx.ui.notify("Active mode no longer exists in config. Reverted to default.", "warning");
				return;
			}
			ctx.ui.notify("Custom mode config reloaded.", "info");
		},
	});

	pi.on("context", async (event, ctx) => {
		const baseFiltered = event.messages.filter((m) => {
			const msg = m as { customType?: string; details?: { mode?: string } };
			if (msg.customType !== "custom-mode-context") return true;
			if (activeMode === "default") return false;
			return msg.details?.mode === activeMode;
		});

		if (activeMode === "default") return { messages: baseFiltered };
		const def = definitions[activeMode];
		if (!def?.hooks?.context) return { messages: baseFiltered };

		const hookResult = await def.hooks.context(
			{ messages: baseFiltered as Array<{ customType?: string; details?: Record<string, unknown> }> },
			ctx,
		);
		return hookResult ?? { messages: baseFiltered };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (getPlanModeEnabled(ctx) && activeMode !== "default") {
			deactivateCustomModeState(ctx);
		}

		if (activeMode === "default") return;
		const def = definitions[activeMode];
		if (!def) return;

		let nextSystemPrompt = event.systemPrompt;
		if (def.promptText?.trim()) {
			nextSystemPrompt = def.promptStrategy === "replace"
				? def.promptText
				: `${event.systemPrompt}\n\n${def.promptText}`;
		}

		const hookResult = await def.hooks?.beforeAgentStart?.({ systemPrompt: nextSystemPrompt, prompt: event.prompt }, ctx);
		const message = hookResult?.message ?? {
			customType: "custom-mode-context",
			content: `[CUSTOM MODE ACTIVE: ${activeMode}]`,
			display: false,
			details: { mode: activeMode },
		};

		return {
			systemPrompt: hookResult?.systemPrompt ?? nextSystemPrompt,
			message: message.customType === "custom-mode-context"
				? { ...message, details: { ...(message.details ?? {}), mode: activeMode } }
				: message,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (activeMode === "default") return;
		const def = definitions[activeMode];
		if (!def?.hooks?.toolCall) return;
		return def.hooks.toolCall({ toolName: event.toolName, input: event.input as Record<string, unknown> }, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadConfig(ctx);

		const availableTools = new Set(pi.getAllTools().map((t) => t.name));
		const discoveredNormal = pi.getActiveTools().filter((name) => !PLAN_ONLY_TOOLS.includes(name));
		const fallbackAvailable = NORMAL_MODE_FALLBACK_TOOLS.filter((name) => availableTools.has(name));
		normalModeTools = Array.from(new Set([...discoveredNormal, ...fallbackAvailable]));

		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: PersistedModesState;
		}>;
		const state = entries.filter((e) => e.type === "custom" && e.customType === MODE_STATE_CUSTOM_TYPE).pop();
		const restored = normalizeModeName(state?.data?.activeMode ?? "default");
		activeMode = restored !== "default" && !definitions[restored] ? "default" : restored;

		if (getPlanModeEnabled(ctx)) {
			if (activeMode !== "default") deactivateCustomModeState(ctx);
			else updateStatus(ctx);
			return;
		}

		if (activeMode !== "default") {
			applyToolSet(resolveModeTools(activeMode));
		}
		updateStatus(ctx);
	});

	pi.registerCommand("mode-file", {
		description: "Show project and global custom mode config paths",
		handler: async (_args, ctx) => {
			const project = getConfigPath(ctx.cwd, "project");
			const global = getConfigPath(ctx.cwd, "global");
			ctx.ui.notify(
				`Project config: ${relative(ctx.cwd, project)}\nGlobal config: ${formatDisplayPath(global)}`,
				"info",
			);
		},
	});
}
