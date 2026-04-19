import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMode, getStartupMode } from "../../config/config.js";
import type { MagpieConfig } from "../../config/types.js";

export const MODE_STATE_TYPE = "magpie:mode-state";

export function normalizeMagpieModeName(input: string): string {
	const normalized = input.trim().toLowerCase();
	if (normalized === "default" || normalized === "off" || normalized === "build") return "smart";
	return normalized;
}

export function getActiveModeName(ctx: ExtensionContext, config: MagpieConfig): string {
	const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { activeMode?: string } }>;
	const state = entries
		.filter((entry) => entry.type === "custom" && entry.customType === MODE_STATE_TYPE)
		.pop();
	return normalizeMagpieModeName(state?.data?.activeMode ?? getStartupMode(config));
}

export function getActiveModeConfig(ctx: ExtensionContext, config: MagpieConfig) {
	return getMode(config, getActiveModeName(ctx, config)) ?? getMode(config, getStartupMode(config)) ?? getMode(config, "smart");
}

export function isToolDisabledInMode(config: MagpieConfig, modeName: string, toolName: string): boolean {
	const mode = getMode(config, modeName);
	return mode?.disableTools?.includes(toolName) === true;
}

export function isToolDisabledInActiveMode(ctx: ExtensionContext, config: MagpieConfig, toolName: string): boolean {
	return isToolDisabledInMode(config, getActiveModeName(ctx, config), toolName);
}

export function isAnyToolDisabledInActiveMode(ctx: ExtensionContext, config: MagpieConfig, toolNames: string[]): boolean {
	return toolNames.some((toolName) => isToolDisabledInActiveMode(ctx, config, toolName));
}
