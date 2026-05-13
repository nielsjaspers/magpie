import { basename } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TodoItem } from "./utils.js";

export function updatePlanStatus(ctx: ExtensionContext, input: {
	planModeEnabled: boolean;
	executionMode: boolean;
	todoItems: TodoItem[];
	activePlanFile?: string;
}) {
	if (input.executionMode && input.todoItems.length > 0) {
		const complete = input.todoItems.filter((item) => item.completed).length;
		ctx.ui.setStatus("magpie-plan", ctx.ui.theme.fg("accent", `📋 ${complete}/${input.todoItems.length}`));
		ctx.ui.setWidget("magpie-plan-todos", input.todoItems.map((item) => item.completed ? `☑ ${item.text}` : `☐ ${item.text}`));
		return;
	}
	ctx.ui.setWidget("magpie-plan-todos", undefined);
	if (input.planModeEnabled) {
		ctx.ui.setStatus("magpie-plan", ctx.ui.theme.fg("warning", input.activePlanFile ? `⏸ plan:${basename(input.activePlanFile)}` : "⏸ plan"));
		return;
	}
	ctx.ui.setStatus("magpie-plan", undefined);
}
