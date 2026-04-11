import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PromptStrategy = "append" | "replace";
export type ModeConfigScope = "global" | "project";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PlanBehavior = "none" | "enter-plan";

export type SubagentConceptName = "Search" | "Oracle" | "Librarian";

export interface SubagentConceptDefinition {
	description?: string;
	whenToUse?: string;
	preferredTools?: string[];
	promptHint?: string;
	modeHint?: string;
	model?: string;
}

export type ModeSubagentConcepts = Partial<Record<SubagentConceptName, SubagentConceptDefinition>>;

// Placeholder structure for future system-model routing.
// Not applied at runtime yet (kept intentionally forward-compatible).
export interface ModeSystemModelRefs {
	lookAt?: string;
	handoff?: string;
	titling?: string;
}

export interface ModeHooks {
	beforeAgentStart?: (event: { systemPrompt: string; prompt: string }, ctx: ExtensionContext) => Promise<
		| {
				systemPrompt?: string;
				message?: {
					customType: string;
					content: string;
					display?: boolean;
					details?: Record<string, unknown>;
				};
		  }
		| undefined
	>;
	context?: (
		event: { messages: Array<{ customType?: string; details?: Record<string, unknown> }> },
		ctx: ExtensionContext,
	) => Promise<{ messages?: Array<{ customType?: string; details?: Record<string, unknown> }> } | undefined>;
	toolCall?: (
		event: { toolName: string; input: Record<string, unknown> },
		ctx: ExtensionContext,
	) => Promise<{ block: boolean; reason?: string } | undefined>;
}

export interface ModeDefinition {
	name: string;
	description?: string;
	statusLabel?: string;
	tools?: string[];
	promptStrategy?: PromptStrategy;
	promptText?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	planBehavior?: PlanBehavior;
	subagents?: ModeSubagentConcepts;
	systemModels?: ModeSystemModelRefs;
	hooks?: ModeHooks;
}

export interface JsonPromptConfig {
	strategy?: PromptStrategy;
	text?: string;
	file?: string;
}

export interface JsonModeConfig {
	description?: string;
	statusLabel?: string;
	tools?: string[];
	prompt?: JsonPromptConfig;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	planBehavior?: PlanBehavior;
	subagents?: ModeSubagentConcepts;
	systemModels?: ModeSystemModelRefs;
}

export interface JsonModesConfig {
	aliases?: Record<string, string>;
	modes?: Record<string, JsonModeConfig>;
}

export interface PersistedModesState {
	activeMode?: string;
}
