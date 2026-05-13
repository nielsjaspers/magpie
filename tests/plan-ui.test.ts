import { describe, expect, test } from "bun:test";
import { updatePlanStatus } from "../plan/ui.js";

function ctx() {
	const calls: unknown[] = [];
	return {
		calls,
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: (...args: unknown[]) => calls.push(["status", ...args]),
			setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
		},
	} as any;
}

describe("plan UI status", () => {
	test("renders execution progress and clears inactive status", () => {
		const active = ctx();
		updatePlanStatus(active, {
			planModeEnabled: false,
			executionMode: true,
			activePlanFile: "/tmp/plan.plan.md",
			todoItems: [{ step: 1, text: "One", completed: true }, { step: 2, text: "Two", completed: false }],
		});
		expect(active.calls).toContainEqual(["status", "magpie-plan", "📋 1/2"]);
		expect(active.calls).toContainEqual(["widget", "magpie-plan-todos", ["☑ One", "☐ Two"]]);

		const inactive = ctx();
		updatePlanStatus(inactive, { planModeEnabled: false, executionMode: false, todoItems: [] });
		expect(inactive.calls).toEqual([
			["widget", "magpie-plan-todos", undefined],
			["status", "magpie-plan", undefined],
		]);
	});
});
