import type { TodoItem } from "./utils.js";

export const PLAN_STATE_TYPE = "magpie:plan-state";

export type PlanState = {
	enabled: boolean;
	executing: boolean;
	pendingApproval: boolean;
	todos: TodoItem[];
	planFile?: string;
	planSlug?: string;
};

export function initialPlanState(): PlanState {
	return {
		enabled: false,
		executing: false,
		pendingApproval: false,
		todos: [],
	};
}

export function enablePlanState(state: PlanState, input?: { planFile?: string; planSlug?: string }): PlanState {
	return {
		enabled: true,
		executing: false,
		pendingApproval: false,
		todos: [],
		planFile: input?.planFile,
		planSlug: input?.planSlug,
	};
}

export function disablePlanState(_state: PlanState): PlanState {
	return initialPlanState();
}

export function finalizePlanState(state: PlanState, planFile: string, todos: TodoItem[]): PlanState {
	return {
		...state,
		enabled: true,
		executing: false,
		pendingApproval: true,
		planFile,
		todos,
	};
}

export function executePlanState(state: PlanState): PlanState {
	return {
		...state,
		enabled: false,
		executing: true,
		pendingApproval: false,
	};
}

export function completePlanExecutionState(state: PlanState): PlanState {
	return {
		...state,
		executing: false,
		todos: [],
		pendingApproval: false,
	};
}

export function hydratePlanState(value: unknown): PlanState {
	if (!value || typeof value !== "object") return initialPlanState();
	const raw = value as Partial<PlanState>;
	return {
		enabled: raw.enabled === true,
		executing: raw.executing === true,
		pendingApproval: raw.pendingApproval === true,
		todos: Array.isArray(raw.todos) ? raw.todos : [],
		planFile: typeof raw.planFile === "string" ? raw.planFile : undefined,
		planSlug: typeof raw.planSlug === "string" ? raw.planSlug : undefined,
	};
}
