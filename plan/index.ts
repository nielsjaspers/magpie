import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { StringEnum, type AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { loadConfig } from "../config/config.js";
import { runQuestionnaire } from "./questionnaire.js";
import { extractTodoItems, isPlanPath, isSafeCommand, markCompletedSteps, randomName, slugify, type TodoItem } from "./utils.js";

const PLAN_STATE_TYPE = "magpie:plan-state";
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit", "web_search", "web_fetch", "session_query", "plan_subagent", "user_question", "plan_exit"];
const PLAN_ONLY_TOOLS = ["plan_subagent", "user_question", "plan_exit"];
const MAX_STRICT_LOOP_VIOLATIONS = 3;

type PlanState = {
	enabled: boolean;
	executing: boolean;
	pendingApproval: boolean;
	todos: TodoItem[];
	planFile?: string;
	planSlug?: string;
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return (message as any).role === "assistant" && Array.isArray((message as any).content);
}

function getTextContent(message: AssistantMessage): string {
	return (message as any).content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	let planModeEnabled = false;
	let executionMode = false;
	let pendingApproval = false;
	let todoItems: TodoItem[] = [];
	let activePlanFile: string | undefined;
	let planSlug: string | undefined;
	let latestCtx: ExtensionContext | undefined;
	let lastToolNameInTurn: string | undefined;
	let strictLoopViolations = 0;
	let normalTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "session_query"];

	pi.events.on("magpie:subagent-core:register", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});
	pi.events.emit("magpie:subagent-core:get", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});

	const plansDir = (cwd: string) => resolve(cwd, ".pi/plans");

	const applyTools = (desired: string[]) => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(desired.filter((tool) => available.has(tool)));
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (executionMode && todoItems.length > 0) {
			const complete = todoItems.filter((item) => item.completed).length;
			ctx.ui.setStatus("magpie-plan", ctx.ui.theme.fg("accent", `📋 ${complete}/${todoItems.length}`));
			ctx.ui.setWidget("magpie-plan-todos", todoItems.map((item) => item.completed ? `☑ ${item.text}` : `☐ ${item.text}`));
			return;
		}
		ctx.ui.setWidget("magpie-plan-todos", undefined);
		if (planModeEnabled) {
			ctx.ui.setStatus("magpie-plan", ctx.ui.theme.fg("warning", activePlanFile ? `⏸ plan:${basename(activePlanFile)}` : "⏸ plan"));
			return;
		}
		ctx.ui.setStatus("magpie-plan", undefined);
	};

	const persistState = () => {
		pi.appendEntry(PLAN_STATE_TYPE, {
			enabled: planModeEnabled,
			executing: executionMode,
			pendingApproval,
			todos: todoItems,
			planFile: activePlanFile,
			planSlug,
		} satisfies PlanState);
	};

	const getPlanPath = async (cwd: string, seed?: string) => {
		if (activePlanFile) return activePlanFile;
		if (seed?.trim()) planSlug = slugify(seed);
		await mkdir(plansDir(cwd), { recursive: true });
		const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
		const slug = planSlug ?? `${timestamp}-${randomName()}`;
		activePlanFile = resolve(plansDir(cwd), `${slug}.plan.md`);
		return activePlanFile;
	};

	const setPlanMode = async (ctx: ExtensionContext, enabled: boolean, seed?: string) => {
		latestCtx = ctx;
		planModeEnabled = enabled;
		executionMode = false;
		pendingApproval = false;
		todoItems = [];
		lastToolNameInTurn = undefined;
		strictLoopViolations = 0;
		if (enabled) {
			if (seed?.trim()) {
				planSlug = slugify(seed);
				activePlanFile = undefined;
			}
			const file = await getPlanPath(ctx.cwd, seed);
			applyTools(PLAN_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Plan file: ${relative(ctx.cwd, file)}`, "info");
		} else {
			applyTools(normalTools);
			ctx.ui.notify("Plan mode disabled.", "info");
		}
		updateStatus(ctx);
		persistState();
	};

	pi.events.on("magpie:plan:enable", (payload: { seed?: string } | undefined) => {
		if (latestCtx) void setPlanMode(latestCtx, true, payload?.seed);
	});
	pi.events.on("magpie:plan:disable", () => {
		if (latestCtx) void setPlanMode(latestCtx, false);
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode. Optional arg seeds deterministic filename",
		handler: async (args, ctx) => {
			if (!planModeEnabled) await setPlanMode(ctx, true, args?.trim() || undefined);
			else await setPlanMode(ctx, false);
		},
	});

	pi.registerCommand("plan-file", {
		description: "Show active plan file",
		handler: async (_args, ctx) => {
			const file = await getPlanPath(ctx.cwd);
			ctx.ui.notify(`Plan file: ${relative(ctx.cwd, file)}`, "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			ctx.ui.notify(todoItems.length ? todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n") : "No tracked steps yet.", "info");
		},
	});

	pi.registerTool({
		name: "plan_subagent",
		label: "Plan Subagent",
		description: "Spawn one or more read-only subagents for planning research.",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				role: StringEnum(["explore", "design", "risk", "custom"] as const),
				title: Type.Optional(Type.String()),
				task: Type.String(),
				model: Type.Optional(Type.String()),
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!planModeEnabled || executionMode) return { content: [{ type: "text", text: "plan_subagent can only be used in planning mode." }], details: {}, isError: true };
			if (!subagentCore) return { content: [{ type: "text", text: "Subagent core unavailable." }], details: {}, isError: true };
			const config = await loadConfig(ctx.cwd);
			const specs = params.tasks.slice(0, 6).map((task, index) => ({
				role: "plan" as const,
				planSubRole: task.role,
				label: task.title || `${task.role}-${index + 1}`,
				task: task.task,
				model: task.model,
				tools: "readonly" as const,
			}));
			const results = await subagentCore.runSubagentBatch(ctx, config, specs, signal, (index, progress) => {
				onUpdate?.({ content: [{ type: "text", text: `Subagents progress: ${index + 1}/${specs.length}` }], details: { progress } });
			});
			const successful = results.filter((result) => result.exitCode === 0).length;
			return {
				content: [{ type: "text", text: results.map((result, index) => `### ${index + 1}. [${result.spec.planSubRole}] ${result.spec.label}\n\n${result.output}`).join("\n\n---\n\n") }],
				details: { results },
				isError: successful === 0,
			};
		},
	});

	pi.registerTool({
		name: "user_question",
		label: "User Question",
		description: "Ask one or more clarification questions.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			questions: Type.Array(Type.Object({
				id: Type.Optional(Type.String()),
				question: Type.String(),
				options: Type.Optional(Type.Array(Type.Object({
					value: Type.String(),
					label: Type.String(),
					description: Type.Optional(Type.String()),
				}))),
				multiSelect: Type.Optional(Type.Boolean()),
				allowCustom: Type.Optional(Type.Boolean()),
			}), { minItems: 1, maxItems: 6 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "No interactive UI available for user questions." }], details: {}, isError: true };
			const result = await runQuestionnaire(ctx, params.questions, params.title);
			if (result.cancelled) return { content: [{ type: "text", text: "User cancelled question flow." }], details: result };
			const summary = result.answers.map((answer, index) => `${index + 1}. ${answer.id}: ${[answer.selected.map((item) => `${item.label}(${item.value})`).join(", "), answer.custom.join(", ")].filter(Boolean).join(" | ") || "(empty)"}`).join("\n");
			return { content: [{ type: "text", text: `User answers:\n${summary}` }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_exit",
		label: "Plan Exit",
		description: "Finalize planning. Requires a non-empty .pi/plans/*.plan.md file, then prompts execute/stay/refine.",
		parameters: Type.Object({
			planPath: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled || executionMode) return { content: [{ type: "text", text: "plan_exit can only be used in planning mode." }], details: {}, isError: true };
			const pathArg = params.planPath ?? (activePlanFile ? relative(ctx.cwd, activePlanFile) : undefined);
			if (!pathArg) return { content: [{ type: "text", text: "No plan file selected yet." }], details: {}, isError: true };
			if (!isPlanPath(pathArg, ctx.cwd)) return { content: [{ type: "text", text: "plan_exit only accepts .pi/plans/*.plan.md files." }], details: {}, isError: true };
			activePlanFile = resolve(ctx.cwd, pathArg);
			let content = "";
			try {
				content = await readFile(activePlanFile, "utf8");
			} catch {
				return { content: [{ type: "text", text: `Plan file not found: ${relative(ctx.cwd, activePlanFile)}` }], details: {}, isError: true };
			}
			if (!content.trim()) return { content: [{ type: "text", text: "Plan file is empty." }], details: {}, isError: true };
			todoItems = extractTodoItems(content);
			pendingApproval = true;
			persistState();
			updateStatus(ctx);
			return { content: [{ type: "text", text: `Plan finalized at ${relative(ctx.cwd, activePlanFile)}.` }], details: { planFile: activePlanFile, steps: todoItems.length } };
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled || executionMode) return;
		if (!PLAN_TOOLS.includes(event.toolName)) {
			return { block: true, reason: `Plan mode blocked tool: ${event.toolName}. Allowed: ${PLAN_TOOLS.join(", ")}` };
		}
		if (event.toolName === "bash") {
			const command = String((event as any).input.command ?? "");
			if (!isSafeCommand(command)) return { block: true, reason: `Plan mode blocked command: ${command}` };
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const pathArg = String((event as any).input.path ?? "");
			if (!isPlanPath(pathArg, ctx.cwd)) return { block: true, reason: "Plan mode: write/edit only allowed for .pi/plans/*.plan.md." };
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;
		return {
			messages: event.messages.filter((message: any) => !["magpie:plan-context", "magpie:plan-execute", "magpie:plan-loop", "magpie:plan-complete"].includes(message.customType)),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled && !executionMode) {
			const file = await getPlanPath(ctx.cwd);
			const rel = relative(ctx.cwd, file);
			return {
				message: {
					customType: "magpie:plan-context",
					content: `[PLAN MODE ACTIVE]\nPlan file: ${rel}\nRules:\n- Read-only exploration except write/edit for ${rel}\n- Use plan_subagent, user_question, and plan_exit\n- Use web_search/web_fetch/session_query when needed\n- End each turn with user_question or plan_exit`,
					display: false,
				},
			};
		}
		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed).map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: "magpie:plan-execute",
					content: `[EXECUTING PLAN]\nRemaining steps:\n${remaining}\n\nExecute in order and include [DONE:n] after each completed step.`,
					display: false,
				},
			};
		}
	});

	pi.on("agent_start", async () => {
		lastToolNameInTurn = undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (!planModeEnabled || executionMode) return;
		lastToolNameInTurn = event.toolName;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message as AgentMessage)) return;
		const text = getTextContent(event.message as AssistantMessage);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		if (executionMode && todoItems.length > 0 && todoItems.every((item) => item.completed)) {
			pi.sendMessage({ customType: "magpie:plan-complete", content: [{ type: "text", text: "Plan complete." }], display: true }, { triggerTurn: false });
			executionMode = false;
			todoItems = [];
			applyTools(normalTools);
			persistState();
			updateStatus(ctx);
			return;
		}
		if (planModeEnabled && !executionMode && !pendingApproval) {
			const endedCorrectly = lastToolNameInTurn === "user_question" || lastToolNameInTurn === "plan_exit";
			if (!endedCorrectly) {
				strictLoopViolations += 1;
				if (strictLoopViolations <= MAX_STRICT_LOOP_VIOLATIONS) {
					pi.sendMessage({ customType: "magpie:plan-loop", content: [{ type: "text", text: "Strict loop reminder: continue planning and end with user_question or plan_exit." }], display: true }, { triggerTurn: true });
				} else {
					ctx.ui.notify("Plan strict-loop guard hit repeatedly. Please steer the model.", "warning");
				}
			} else {
				strictLoopViolations = 0;
			}
		}
		if (!pendingApproval || !ctx.hasUI) return;
		pendingApproval = false;
		const choice = await ctx.ui.select("Plan complete. What next?", ["Execute the plan", "Stay in plan mode", "Refine the plan"]);
		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = true;
			applyTools(normalTools);
			persistState();
			updateStatus(ctx);
			pi.sendMessage({ customType: "magpie:plan-execute", content: [{ type: "text", text: "Execute the approved plan." }], display: true }, { triggerTurn: true });
			return;
		}
		if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
		persistState();
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		normalTools = Array.from(new Set([...pi.getActiveTools().filter((name) => !PLAN_ONLY_TOOLS.includes(name)), ...normalTools]));
		const stateEntry = (ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: PlanState }>)
			.filter((entry) => entry.type === "custom" && entry.customType === PLAN_STATE_TYPE)
			.pop();
		if (stateEntry?.data) {
			planModeEnabled = stateEntry.data.enabled;
			executionMode = stateEntry.data.executing;
			pendingApproval = stateEntry.data.pendingApproval;
			todoItems = stateEntry.data.todos ?? [];
			activePlanFile = stateEntry.data.planFile;
			planSlug = stateEntry.data.planSlug;
		}
		if (planModeEnabled && !activePlanFile) await getPlanPath(ctx.cwd);
		if (executionMode && todoItems.length > 0 && activePlanFile && existsSync(activePlanFile)) {
			const branch = ctx.sessionManager.getEntries() as Array<{ type: string; message?: AgentMessage; customType?: string }>;
			const allText = branch.filter((entry) => entry.type === "message" && entry.message && isAssistantMessage(entry.message)).map((entry) => getTextContent(entry.message as AssistantMessage)).join("\n");
			markCompletedSteps(allText, todoItems);
		}
		if (planModeEnabled && !executionMode) applyTools(PLAN_TOOLS);
		else applyTools(normalTools);
		updateStatus(ctx);
	});
}
