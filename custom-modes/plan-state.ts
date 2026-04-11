import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PLAN_STATE_CUSTOM_TYPE } from "./mode-definitions.js";

export interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	pendingApproval: boolean;
	todos: Array<{ step: number; text: string; completed: boolean }>;
	planFile?: string;
	planSlug?: string;
}

export function getPlanModeState(ctx: ExtensionContext): PlanModeState | undefined {
	const entries = ctx.sessionManager.getEntries() as Array<{
		type: string;
		customType?: string;
		data?: Partial<PlanModeState>;
	}>;
	const state = entries
		.filter((e) => e.type === "custom" && e.customType === PLAN_STATE_CUSTOM_TYPE)
		.pop()?.data;
	if (!state) return undefined;

	return {
		enabled: state.enabled === true,
		executing: state.executing === true,
		pendingApproval: state.pendingApproval === true,
		todos: Array.isArray(state.todos) ? state.todos : [],
		planFile: state.planFile,
		planSlug: state.planSlug,
	};
}

export function getPlanModeEnabled(ctx: ExtensionContext): boolean {
	return getPlanModeState(ctx)?.enabled === true;
}

export function buildPlanModeState(previous: PlanModeState | undefined, enabled: boolean): PlanModeState {
	return {
		enabled,
		executing: false,
		pendingApproval: false,
		todos: [],
		planFile: previous?.planFile,
		planSlug: previous?.planSlug,
	};
}
