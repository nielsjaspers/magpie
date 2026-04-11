import type { ModeDefinition } from "./types.js";

export const MODE_STATUS_KEY = "custom-modes";
export const MODE_STATE_CUSTOM_TYPE = "custom-modes-state";
export const PLAN_STATE_CUSTOM_TYPE = "plan-mode-plus";

export const PLAN_ONLY_TOOLS = ["plan_subagent", "user_question", "plan_exit"];
export const NORMAL_MODE_FALLBACK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];

const LEARN_PROMPT = `You are in Learning mode.

Goals:
- Be collaborative and educational while still moving the task forward.
- Explain the why behind decisions with concrete, codebase-specific insights.
- Prefer short, practical explanations over generic tutorials.

Insight format:
Use this exact wrapper for insights in conversation output (never in files):

★ Insight ─────────────────────────────────────
- [2-3 concise, codebase-specific points]
─────────────────────────────────────────────────

Learn by Doing:
- When implementing substantial decision-heavy code, invite user participation with TODO(human) markers.
- Multiple TODO(human) markers are allowed when useful.
- For each request, provide clear context, task, and guidance.

Do not write educational insight blocks into project files unless explicitly asked.`;

export const CODE_MODES: Record<string, ModeDefinition> = {
	learn: {
		name: "learn",
		description: "Collaborative educational mode with insight-oriented output.",
		statusLabel: "🎓 learn",
		promptStrategy: "append",
		promptText: LEARN_PROMPT,
	},
};

export function normalizeModeName(mode: string): string {
	const normalized = mode.trim().toLowerCase();
	if (normalized === "build" || normalized === "default" || normalized === "off") return "default";
	return normalized;
}

export function mergeMode(base: ModeDefinition | undefined, override: Partial<ModeDefinition>, name: string): ModeDefinition {
	return {
		name,
		description: override.description ?? base?.description,
		statusLabel: override.statusLabel ?? base?.statusLabel,
		tools: override.tools ?? base?.tools,
		promptStrategy: override.promptStrategy ?? base?.promptStrategy,
		promptText: override.promptText ?? base?.promptText,
		hooks: override.hooks ?? base?.hooks,
	};
}

export function cloneCodeModes(): Record<string, ModeDefinition> {
	const out: Record<string, ModeDefinition> = {};
	for (const [name, def] of Object.entries(CODE_MODES)) {
		out[name] = { ...def, hooks: def.hooks ? { ...def.hooks } : undefined };
	}
	return out;
}
