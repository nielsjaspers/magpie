import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isPlanPath, isSafeCommand, markCompletedSteps, slugify, type TodoItem } from "./utils.js";

const PLAN_MODE_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"web_search",
	"plan_subagent",
	"user_question",
	"plan_exit",
];

const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const SUBAGENT_BUILTIN_TOOLS = "read,bash,grep,find,ls";
const MAX_SUBAGENTS = 4;
const MAX_STRICT_LOOP_VIOLATIONS = 3;

type SubagentRole = "explore" | "design" | "risk" | "custom";
type PlanConfigScope = "global" | "project";

interface PlanState {
	enabled: boolean;
	executing: boolean;
	pendingApproval: boolean;
	todos: TodoItem[];
	planFile?: string;
	planSlug?: string;
}

interface Invocation {
	command: string;
	args: string[];
}

interface SubagentTaskSpec {
	role: SubagentRole;
	title: string;
	task: string;
	model?: string;
}

interface SubagentResult {
	role: SubagentRole;
	title: string;
	task: string;
	model?: string;
	output: string;
	exitCode: number;
	stderr: string;
}

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface QuestionAnswer {
	id: string;
	question: string;
	kind: "freeform" | "single" | "multi";
	selected: Array<{ value: string; label: string }>;
	custom: string[];
	cancelled?: boolean;
}

interface PlanModeConfig {
	subagentModels?: {
		default?: string;
		explore?: string;
		design?: string;
		risk?: string;
		custom?: string;
	};
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getPiInvocation(args: string[]): Invocation {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function getCurrentModelRef(ctx: ExtensionContext): string | undefined {
	const model = (ctx as ExtensionContext & { model?: { provider?: string; id?: string } }).model;
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function chooseRoleModel(role: SubagentRole, explicitModel: string | undefined, config: PlanModeConfig): string | undefined {
	if (explicitModel && explicitModel.trim().length > 0) return explicitModel.trim();
	const configured = config.subagentModels?.[role] ?? config.subagentModels?.default;
	if (configured && configured.trim().length > 0) return configured.trim();
	return undefined;
}

function rolePrompt(role: SubagentRole, task: string): string {
	if (role === "explore") {
		return `You are an EXPLORE sub-agent. Investigate the codebase quickly and precisely.\n\nTask:\n${task}\n\nRequirements:\n- Read-only only\n- You may use web_search for external research\n- Focus on locating relevant files, call paths, symbols, and existing patterns\n- Include concrete evidence with file paths\n- Keep output concise\n\nOutput:\n## Findings\n- ...\n\n## Evidence\n- path/to/file.ts (why relevant)\n\n## Unknowns\n- ...`;
	}
	if (role === "design") {
		return `You are a DESIGN sub-agent. Propose implementation approaches based on available evidence.\n\nTask:\n${task}\n\nRequirements:\n- Read-only only\n- You may use web_search for external research\n- Compare 1-2 viable approaches with tradeoffs\n- Emphasize maintainability and blast radius\n\nOutput:\n## Proposed Approaches\n- ...\n\n## Recommended Approach\n- ...\n\n## Affected Areas\n- path/to/file.ts (expected changes)`;
	}
	if (role === "risk") {
		return `You are a RISK sub-agent. Stress-test the plan and identify failure modes.\n\nTask:\n${task}\n\nRequirements:\n- Read-only only\n- You may use web_search for external research\n- Focus on edge cases, regressions, migrations, and test strategy\n- Highlight unknown assumptions\n\nOutput:\n## Risks\n- ...\n\n## Mitigations\n- ...\n\n## Validation\n- tests/checks to run`;
	}
	return `You are a planning sub-agent. Investigate and report findings only.\n\nTask:\n${task}\n\nOutput:\n## Findings\n- ...\n\n## Evidence\n- ...`;
}

async function runSubagentTask(
	cwd: string,
	spec: SubagentTaskSpec,
	copilotAgentHeader: boolean,
	signal: AbortSignal | undefined,
): Promise<SubagentResult> {
	const prompt = rolePrompt(spec.role, spec.task);
	const args = ["--mode", "json", "-p", "--no-session", "--tools", SUBAGENT_BUILTIN_TOOLS];
	if (spec.model) args.push("--model", spec.model);
	args.push(prompt);

	const invocation = getPiInvocation(args);

	return new Promise<SubagentResult>((resolvePromise) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_PLAN_SUBAGENT: "1",
				PI_PLAN_SUBAGENT_ROLE: spec.role,
				...(copilotAgentHeader ? { PI_PLAN_SUBAGENT_COPILOT: "1" } : {}),
			},
		});

		let stdoutBuffer = "";
		let stderr = "";
		let finalText = "";

		const parseLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				if (event.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content)) {
					const text = event.message.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();
					if (text.length > 0) finalText = text;
				}
			} catch {
				// ignore parse errors
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) parseLine(line);
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
			resolvePromise({
				role: spec.role,
				title: spec.title,
				task: spec.task,
				model: spec.model,
				output: finalText || stderr || "(no output)",
				exitCode: code ?? 0,
				stderr,
			});
		});

		proc.on("error", (err) => {
			resolvePromise({
				role: spec.role,
				title: spec.title,
				task: spec.task,
				model: spec.model,
				output: `Failed to start subagent: ${err.message}`,
				exitCode: 1,
				stderr: err.message,
			});
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

function parseSingleChoice(choice: string): number | undefined {
	const match = choice.match(/^(\d+)\./);
	if (!match) return undefined;
	const idx = Number(match[1]);
	if (!Number.isFinite(idx) || idx < 1) return undefined;
	return idx - 1;
}

function parseMultiSelect(raw: string, options: QuestionOption[], allowCustom: boolean): { selected: QuestionOption[]; custom: string[] } {
	const selected: QuestionOption[] = [];
	const custom: string[] = [];
	const tokens = raw
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	for (const token of tokens) {
		if (/^\d+$/.test(token)) {
			const idx = Number(token) - 1;
			if (idx >= 0 && idx < options.length) {
				const option = options[idx];
				if (!selected.some((s) => s.value === option.value)) selected.push(option);
				continue;
			}
		}
		if (allowCustom) custom.push(token);
	}
	return { selected, custom };
}

function getProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi/plan-mode.json");
}

function getGlobalConfigPath(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent");
	return resolve(baseDir, "plan-mode.json");
}

function getConfigPath(cwd: string, scope: PlanConfigScope = "project"): string {
	return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

function formatDisplayPath(filePath: string): string {
	return filePath.startsWith(homedir()) ? `~${filePath.slice(homedir().length)}` : filePath;
}

const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = {
	subagentModels: {
		default: "github-copilot/gpt-5.4-mini",
		explore: "github-copilot/gemini-3-flash-preview",
		design: "github-copilot/gemini-3-flash-preview",
		risk: "github-copilot/claude-haiku-4-5",
		custom: "github-copilot/gpt-5-mini",
	},
};

async function readPlanConfigFile(path: string): Promise<PlanModeConfig | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as PlanModeConfig;
		return {
			subagentModels: parsed.subagentModels,
		};
	} catch {
		return undefined;
	}
}

function mergePlanConfig(base: PlanModeConfig, override: PlanModeConfig | undefined): PlanModeConfig {
	return {
		subagentModels: {
			...base.subagentModels,
			...override?.subagentModels,
		},
	};
}

async function loadPlanConfig(cwd: string): Promise<PlanModeConfig> {
	const globalConfig = await readPlanConfigFile(getConfigPath(cwd, "global"));
	const projectConfig = await readPlanConfigFile(getConfigPath(cwd, "project"));
	return mergePlanConfig(mergePlanConfig(DEFAULT_PLAN_MODE_CONFIG, globalConfig), projectConfig);
}

function defaultConfigText(): string {
	return JSON.stringify(DEFAULT_PLAN_MODE_CONFIG, null, 2);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	const isSubagentProcess = process.env.PI_PLAN_SUBAGENT === "1";

	if (isSubagentProcess) {
		// OpenCode sets x-initiator=agent for subagent sessions with GitHub Copilot.
		// Do the equivalent here for subagent subprocesses.
		if (process.env.PI_PLAN_SUBAGENT_COPILOT === "1") {
			pi.registerProvider("github-copilot", {
				headers: {
					"x-initiator": "agent",
					"Openai-Intent": "conversation-edits",
				},
			});
		}

		pi.on("tool_call", async (event) => {
			if (event.toolName === "bash") {
				const command = String(event.input.command ?? "");
				if (!isSafeCommand(command)) {
					return { block: true, reason: `Subagent mode blocked command: ${command}` };
				}
			}
			if (event.toolName === "write" || event.toolName === "edit") {
				return { block: true, reason: "Subagent mode is read-only." };
			}
		});

		pi.on("before_agent_start", async () => {
			const role = process.env.PI_PLAN_SUBAGENT_ROLE ?? "subagent";
			return {
				message: {
					customType: "plan-subagent-context",
					content: `[PLAN SUBAGENT: ${role}]\nRead-only only. Do not modify files. web_search is allowed for external research.`,
					display: false,
				},
			};
		});

		pi.on("session_start", async () => {
			const all = new Set(pi.getAllTools().map((t) => t.name));
			if (!all.has("web_search")) return;
			const active = new Set(pi.getActiveTools());
			active.add("web_search");
			pi.setActiveTools(Array.from(active));
		});

		return;
	}

	let planModeEnabled = false;
	let executionMode = false;
	let pendingApproval = false;
	let todoItems: TodoItem[] = [];
	let activePlanFile: string | undefined;
	let planSlug: string | undefined;

	let lastToolNameInTurn: string | undefined;
	let strictLoopViolations = 0;

	const plansDir = (cwd: string) => resolve(cwd, ".pi/plans");

	const getPlanPath = async (cwd: string, seed?: string): Promise<string> => {
		if (seed && seed.trim().length > 0) {
			planSlug = slugify(seed);
			activePlanFile = undefined;
		}
		if (activePlanFile) return activePlanFile;
		await mkdir(plansDir(cwd), { recursive: true });
		const slug = planSlug ?? slugify("plan");
		activePlanFile = resolve(plansDir(cwd), `${slug}.plan.md`);
		return activePlanFile;
	};

	const persistState = () => {
		pi.appendEntry("plan-mode-plus", {
			enabled: planModeEnabled,
			executing: executionMode,
			pendingApproval,
			todos: todoItems,
			planFile: activePlanFile,
			planSlug,
		} satisfies PlanState);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			const label = activePlanFile ? `⏸ plan:${basename(activePlanFile)}` : "⏸ plan";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	};

	const applyToolSet = (desired: string[]) => {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(desired.filter((name) => available.has(name)));
	};

	const setPlanModeEnabled = async (ctx: ExtensionContext, enabled: boolean, seed?: string) => {
		planModeEnabled = enabled;
		executionMode = false;
		pendingApproval = false;
		todoItems = [];
		lastToolNameInTurn = undefined;
		strictLoopViolations = 0;

		if (enabled) {
			if (seed && seed.trim().length > 0) {
				planSlug = slugify(seed);
				activePlanFile = undefined;
			}
			const file = await getPlanPath(ctx.cwd, seed);
			applyToolSet(PLAN_MODE_TOOLS);
			ctx.ui.notify(
				`Plan mode enabled. Plan file: ${relative(ctx.cwd, file)}. Use plan_subagent + user_question + plan_exit.`,
				"info",
			);
		} else {
			applyToolSet(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
		}
		updateStatus(ctx);
		persistState();
	};

	pi.registerFlag("plan", {
		description: "Start in plan mode (subagents + user questions + deterministic plan file)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode. Optional arg seeds deterministic filename",
		handler: async (args, ctx) => {
			if (!planModeEnabled) {
				await setPlanModeEnabled(ctx, true, args?.trim() || undefined);
				return;
			}
			await setPlanModeEnabled(ctx, false);
		},
	});

	pi.registerCommand("plan-file", {
		description: "Show active plan file",
		handler: async (_args, ctx) => {
			const file = await getPlanPath(ctx.cwd);
			ctx.ui.notify(`Plan file: ${relative(ctx.cwd, file)}`, "info");
		},
	});

	pi.registerCommand("plan-models", {
		description: "Show effective subagent model configuration",
		handler: async (_args, ctx) => {
			const globalPath = getConfigPath(ctx.cwd, "global");
			const projectPath = getConfigPath(ctx.cwd, "project");
			const effective = await loadPlanConfig(ctx.cwd);
			const globalConfig = await readPlanConfigFile(globalPath);
			const projectConfig = await readPlanConfigFile(projectPath);
			const lines = [
				`Global:  ${formatDisplayPath(globalPath)}`,
				`Project: ${formatDisplayPath(projectPath)}`,
				"",
				`global.default: ${globalConfig?.subagentModels?.default ?? "(missing)"}`,
				`project.default: ${projectConfig?.subagentModels?.default ?? "(missing)"}`,
				`effective.default: ${effective.subagentModels?.default ?? "(auto)"}`,
				"",
				`effective.explore: ${effective.subagentModels?.explore ?? "(auto)"}`,
				`effective.design: ${effective.subagentModels?.design ?? "(auto)"}`,
				`effective.risk: ${effective.subagentModels?.risk ?? "(auto)"}`,
				`effective.custom: ${effective.subagentModels?.custom ?? "(auto)"}`,
			].join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("plan-config", {
		description: "Edit global or in-project plan mode config",
		handler: async (args, ctx) => {
			const normalized = args?.trim().toLowerCase();
			const scope: PlanConfigScope = normalized === "global" ? "global" : "project";
			const path = getConfigPath(ctx.cwd, scope);
			let current = defaultConfigText();
			try {
				current = await readFile(path, "utf8");
			} catch {
				// use defaults
			}

			const label = scope === "global" ? "global" : "project-local";
			const edited = await ctx.ui.editor(`Edit ${label} plan mode config: ${formatDisplayPath(path)}`, current);
			if (!edited) return;

			try {
				JSON.parse(edited);
			} catch (error) {
				ctx.ui.notify(`Invalid JSON: ${(error as Error).message}`, "error");
				return;
			}

			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, edited, "utf8");
			ctx.ui.notify(`Saved ${formatDisplayPath(path)}`, "success");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No tracked steps yet. Add numbered steps to your .plan.md.", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (!planModeEnabled) await setPlanModeEnabled(ctx, true);
			else await setPlanModeEnabled(ctx, false);
		},
	});

	const RoleEnum = Type.Union([Type.Literal("explore"), Type.Literal("design"), Type.Literal("risk"), Type.Literal("custom")]);
	const RoleTaskSchema = Type.Object({
		role: Type.Optional(RoleEnum),
		title: Type.Optional(Type.String({ description: "Short display title" })),
		task: Type.String({ description: "Prompt/task for this subagent" }),
		model: Type.Optional(Type.String({ description: "Optional model override (provider/model)" })),
	});

	pi.registerTool({
		name: "plan_subagent",
		label: "Plan Subagent",
		description:
			"Spawn one or more read-only subagents for planning research. Supports roles: explore, design, risk, custom.",
		parameters: Type.Object({
			role: Type.Optional(RoleEnum),
			title: Type.Optional(Type.String({ description: "Title for single subagent task" })),
			task: Type.Optional(Type.String({ description: "Single subagent task" })),
			tasks: Type.Optional(Type.Array(RoleTaskSchema, { description: "Parallel subagent tasks" })),
			model: Type.Optional(Type.String({ description: "Default model for spawned subagents" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!planModeEnabled || executionMode) {
				return {
					content: [{ type: "text", text: "plan_subagent can only be used while in planning mode." }],
					isError: true,
				};
			}

			const currentModel = getCurrentModelRef(ctx);
			const config = await loadPlanConfig(ctx.cwd);
			const inputTasks = (params.tasks?.length ?? 0) > 0
				? params.tasks!.slice(0, MAX_SUBAGENTS)
				: params.task
					? [{ role: params.role, title: params.title, task: params.task, model: params.model }]
					: [];

			if (inputTasks.length === 0) {
				return {
					content: [{ type: "text", text: "Provide either task or tasks[]." }],
					isError: true,
				};
			}

			const specs: SubagentTaskSpec[] = inputTasks.map((item, i) => {
				const role = (item.role ?? "explore") as SubagentRole;
				const title = item.title?.trim() || `${role}-${i + 1}`;
				const model = chooseRoleModel(role, item.model ?? params.model, config);
				return { role, title, task: item.task, model };
			});

			const copilotHeader = specs.some((s) => (s.model ?? currentModel ?? "").startsWith("github-copilot/"));
			const results: SubagentResult[] = [];

			const runs = specs.map(async (spec, index) => {
				const result = await runSubagentTask(ctx.cwd, spec, copilotHeader, signal);
				results[index] = result;
				onUpdate?.({
					content: [{ type: "text", text: `Subagents progress: ${results.filter(Boolean).length}/${specs.length}` }],
					details: { results },
				});
				return result;
			});

			await Promise.all(runs);
			const successful = results.filter((r) => r.exitCode === 0).length;
			const combined = results
				.map(
					(r, i) =>
						`### ${i + 1}. [${r.role}] ${r.title}${r.exitCode === 0 ? "" : " (failed)"}\nModel: ${r.model ?? "default"}\nTask: ${r.task}\n\n${r.output.trim()}`,
				)
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: `Subagent findings (${successful}/${results.length} succeeded):\n\n${combined}` }],
				details: { results },
				isError: successful === 0,
			};
		},
	});

	const QuestionOptionSchema = Type.Object({
		value: Type.String({ description: "Machine-readable option value" }),
		label: Type.String({ description: "Display label" }),
		description: Type.Optional(Type.String({ description: "Optional helper text" })),
	});

	const UserQuestionSchema = Type.Object({
		id: Type.Optional(Type.String({ description: "Optional question ID" })),
		question: Type.String({ description: "Question text" }),
		options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Optional multiple-choice options" })),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (comma-separated indices)" })),
		allowCustom: Type.Optional(Type.Boolean({ description: "Allow custom freeform answers (default true)" })),
	});

	pi.registerTool({
		name: "user_question",
		label: "User Question",
		description:
			"Ask one or more clarification questions. Supports freeform, single-choice with custom fallback, and multi-select + custom in one call.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Optional dialog title" })),
			questions: Type.Array(UserQuestionSchema, { minItems: 1, maxItems: 6 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive UI available for user questions." }],
					isError: true,
				};
			}

			const answers: QuestionAnswer[] = [];

			for (let i = 0; i < params.questions.length; i++) {
				const q = params.questions[i];
				const id = q.id?.trim() || `q${i + 1}`;
				const options = q.options ?? [];
				const allowCustom = q.allowCustom !== false;

				if (options.length === 0) {
					const answer = await ctx.ui.input(params.title ?? `Question ${i + 1}`, q.question);
					if (answer === undefined) {
						answers.push({
							id,
							question: q.question,
							kind: "freeform",
							selected: [],
							custom: [],
							cancelled: true,
						});
						return {
							content: [{ type: "text", text: "User cancelled question flow." }],
							details: { answers, cancelled: true },
						};
					}
					answers.push({
						id,
						question: q.question,
						kind: "freeform",
						selected: [],
						custom: [answer.trim()],
					});
					continue;
				}

				if (q.multiSelect) {
					const optionList = options
						.map((opt, idx) => `${idx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`)
						.join("\n");
					const inputPrompt = `${q.question}\n\n${optionList}\n\nEnter comma-separated option numbers${allowCustom ? " and/or custom text" : ""}.`;
					const raw = await ctx.ui.input(params.title ?? `Question ${i + 1}`, inputPrompt);
					if (raw === undefined) {
						answers.push({
							id,
							question: q.question,
							kind: "multi",
							selected: [],
							custom: [],
							cancelled: true,
						});
						return {
							content: [{ type: "text", text: "User cancelled question flow." }],
							details: { answers, cancelled: true },
						};
					}
					const parsed = parseMultiSelect(raw, options, allowCustom);
					answers.push({
						id,
						question: q.question,
						kind: "multi",
						selected: parsed.selected.map((s) => ({ value: s.value, label: s.label })),
						custom: parsed.custom,
					});
					continue;
				}

				const choices = options.map((opt, idx) => `${idx + 1}. ${opt.label}`);
				if (allowCustom) choices.push("✍️ Custom answer");

				const picked = await ctx.ui.select(q.question, choices);
				if (!picked) {
					answers.push({
						id,
						question: q.question,
						kind: "single",
						selected: [],
						custom: [],
						cancelled: true,
					});
					return {
						content: [{ type: "text", text: "User cancelled question flow." }],
						details: { answers, cancelled: true },
					};
				}

				if (picked.startsWith("✍️")) {
					const custom = await ctx.ui.input(params.title ?? `Question ${i + 1}`, q.question);
					if (custom === undefined) {
						answers.push({
							id,
							question: q.question,
							kind: "single",
							selected: [],
							custom: [],
							cancelled: true,
						});
						return {
							content: [{ type: "text", text: "User cancelled question flow." }],
							details: { answers, cancelled: true },
						};
					}
					answers.push({
						id,
						question: q.question,
						kind: "single",
						selected: [],
						custom: [custom.trim()],
					});
					continue;
				}

				const selectedIdx = parseSingleChoice(picked);
				const selectedOption = selectedIdx !== undefined ? options[selectedIdx] : undefined;
				if (!selectedOption) {
					return {
						content: [{ type: "text", text: "Unable to parse selected option." }],
						details: { answers, cancelled: true },
						isError: true,
					};
				}
				answers.push({
					id,
					question: q.question,
					kind: "single",
					selected: [{ value: selectedOption.value, label: selectedOption.label }],
					custom: [],
				});
			}

			const summary = answers
				.map((a, idx) => {
					const selected = a.selected.map((s) => `${s.label}(${s.value})`).join(", ");
					const custom = a.custom.join(", ");
					const parts = [selected, custom].filter((p) => p.length > 0);
					return `${idx + 1}. ${a.id}: ${parts.join(" | ") || "(empty)"}`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: `User answers:\n${summary}` }],
				details: { answers, cancelled: false },
			};
		},
	});

	pi.registerTool({
		name: "plan_exit",
		label: "Plan Exit",
		description:
			"Finalize planning. Requires a non-empty .pi/plans/*.plan.md file, then prompts execute/stay/refine.",
		parameters: Type.Object({
			planPath: Type.Optional(Type.String({ description: "Path to plan file (defaults to active file)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled || executionMode) {
				return {
					content: [{ type: "text", text: "plan_exit can only be used in planning mode." }],
					isError: true,
				};
			}

			const fallback = activePlanFile ? relative(ctx.cwd, activePlanFile) : undefined;
			const pathArg = params.planPath ?? fallback;
			if (!pathArg) {
				return {
					content: [{ type: "text", text: "No plan file selected yet. Write/edit .pi/plans/*.plan.md first." }],
					isError: true,
				};
			}
			if (!isPlanPath(pathArg, ctx.cwd)) {
				return {
					content: [{ type: "text", text: "plan_exit only accepts .pi/plans/*.plan.md files." }],
					isError: true,
				};
			}

			activePlanFile = resolve(ctx.cwd, pathArg);
			let content = "";
			try {
				content = await readFile(activePlanFile, "utf8");
			} catch {
				return {
					content: [{ type: "text", text: `Plan file not found: ${relative(ctx.cwd, activePlanFile)}` }],
					isError: true,
				};
			}

			if (content.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Plan file is empty. Please write the plan first." }],
					isError: true,
				};
			}

			todoItems = extractTodoItems(content);
			pendingApproval = true;
			persistState();
			updateStatus(ctx);

			return {
				content: [
					{
						type: "text",
						text: `Plan finalized at ${relative(ctx.cwd, activePlanFile)}. Waiting for user decision (execute / stay / refine).`,
					},
				],
				details: {
					planFile: activePlanFile,
					steps: todoItems.length,
				},
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled || executionMode) return;

		if (!PLAN_MODE_TOOLS.includes(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode blocked tool: ${event.toolName}. Allowed: ${PLAN_MODE_TOOLS.join(", ")}`,
			};
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode blocked command (not allowlisted): ${command}`,
				};
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const pathArg = String(event.input.path ?? "");
			if (!isPlanPath(pathArg, ctx.cwd)) {
				return {
					block: true,
					reason: "Plan mode: write/edit is only allowed for .pi/plans/*.plan.md.",
				};
			}
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return (
					msg.customType !== "plan-mode-context" &&
					msg.customType !== "plan-execution-context" &&
					msg.customType !== "plan-strict-loop"
				);
			}),
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (planModeEnabled && !executionMode) {
			const file = await getPlanPath(ctx.cwd, event.prompt);
			const rel = relative(ctx.cwd, file);
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]\nYou are in a strict planning loop.\n\nPlan file:\n- ${rel}\n\nRules:\n- Read-only exploration, except write/edit for ${rel}\n- Use plan_subagent (roles: explore/design/risk/custom) for research\n- Use web_search when external/current info is needed\n- Use user_question for user clarifications\n- Keep iterating until plan quality is high\n- Then write/update ${rel} and call plan_exit\n\nSTRICT LOOP RULE:\nYour turn must end with either:\n1) a user_question tool call, OR\n2) a plan_exit tool call\nDo not stop planning silently.\n\nPlan structure:\n- Goal\n- Constraints\n- Numbered implementation steps\n- Risks/unknowns\n- Validation/test plan\n\nExecution tracking:\nUse [DONE:n] markers when executing numbered steps.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN]\nRemaining steps:\n${todoList}\n\nExecute each step in order and include [DONE:n] after each completed step.`,
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
		if (executionMode && todoItems.length > 0 && todoItems.every((t) => t.completed)) {
			const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			todoItems = [];
			applyToolSet(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persistState();
			return;
		}

		if (planModeEnabled && !executionMode && !pendingApproval) {
			const endedCorrectly = lastToolNameInTurn === "user_question" || lastToolNameInTurn === "plan_exit";
			if (!endedCorrectly) {
				strictLoopViolations += 1;
				if (strictLoopViolations <= MAX_STRICT_LOOP_VIOLATIONS) {
					pi.sendMessage(
						{
							customType: "plan-strict-loop",
							content:
								"Strict loop reminder: continue planning now and end this turn with either user_question or plan_exit.",
							display: true,
						},
						{ triggerTurn: true },
					);
				} else {
					ctx.ui.notify(
						"Plan strict-loop guard hit repeatedly. Please steer the model (e.g. ask it to end with user_question or plan_exit).",
						"warning",
					);
				}
			} else {
				strictLoopViolations = 0;
			}
		}

		if (!pendingApproval || !ctx.hasUI) return;
		pendingApproval = false;

		const choice = await ctx.ui.select("Plan complete. What next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = true;
			applyToolSet(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persistState();

			const first = todoItems.find((t) => !t.completed)?.text;
			const execMessage = first ? `Execute the approved plan. Start with: ${first}` : "Execute the approved plan.";
			pi.sendMessage({ customType: "plan-mode-execute", content: execMessage, display: true }, { triggerTurn: true });
			return;
		}

		if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}

		persistState();
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode-plus")
			.pop() as { data?: PlanState } | undefined;

		if (stateEntry?.data) {
			planModeEnabled = stateEntry.data.enabled ?? planModeEnabled;
			executionMode = stateEntry.data.executing ?? false;
			pendingApproval = stateEntry.data.pendingApproval ?? false;
			todoItems = stateEntry.data.todos ?? [];
			activePlanFile = stateEntry.data.planFile;
			planSlug = stateEntry.data.planSlug;
		}

		if (planModeEnabled && activePlanFile === undefined) {
			await getPlanPath(ctx.cwd);
		}

		// Rebuild [DONE:n] progress on resume.
		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const assistantMessages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i] as { type: string; message?: AgentMessage };
				if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
					assistantMessages.push(entry.message);
				}
			}
			const allText = assistantMessages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled && !executionMode) {
			applyToolSet(PLAN_MODE_TOOLS);
		} else {
			applyToolSet(NORMAL_MODE_TOOLS);
		}

		updateStatus(ctx);
	});
}
