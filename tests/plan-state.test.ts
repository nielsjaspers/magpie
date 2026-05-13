import { describe, expect, test } from "bun:test";
import {
	completePlanExecutionState,
	disablePlanState,
	enablePlanState,
	executePlanState,
	finalizePlanState,
	hydratePlanState,
	initialPlanState,
} from "../plan/state.js";

describe("plan state transitions", () => {
	test("enables, finalizes, executes, and completes a plan", () => {
		const enabled = enablePlanState(initialPlanState(), { planSlug: "ship-it" });
		expect(enabled).toMatchObject({ enabled: true, executing: false, pendingApproval: false, planSlug: "ship-it", todos: [] });

		const finalized = finalizePlanState(enabled, "/tmp/.pi/plans/ship-it.plan.md", [{ step: 1, text: "Do it", completed: false }]);
		expect(finalized).toMatchObject({ enabled: true, pendingApproval: true, planFile: "/tmp/.pi/plans/ship-it.plan.md" });

		const executing = executePlanState(finalized);
		expect(executing).toMatchObject({ enabled: false, executing: true, pendingApproval: false });

		const completed = completePlanExecutionState(executing);
		expect(completed).toMatchObject({ executing: false, todos: [], pendingApproval: false });
	});

	test("hydrates partial persisted state and disables cleanly", () => {
		expect(hydratePlanState({ enabled: true, todos: "bad", planFile: 1 })).toEqual({
			enabled: true,
			executing: false,
			pendingApproval: false,
			todos: [],
			planFile: undefined,
			planSlug: undefined,
		});
		expect(disablePlanState(enablePlanState(initialPlanState()))).toEqual(initialPlanState());
	});
});
