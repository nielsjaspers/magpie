export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PromptStrategy = "append" | "replace";
export type PlanBehavior = "none" | "enter-plan";
export type HandoffDefaultMode = "default" | "plan";

export interface PromptConfig {
	strategy?: PromptStrategy;
	text?: string;
	file?: string;
}

export type SubagentModelRef = string | {
	model: string;
	thinkingLevel?: ThinkingLevel;
	prompt?: PromptConfig;
};

export type ModePromptConfig = PromptConfig;

export interface ModeConfig {
	statusLabel?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	prompt?: ModePromptConfig;
	planBehavior?: PlanBehavior;
	subagents?: {
		search?: SubagentModelRef;
		oracle?: SubagentModelRef;
		librarian?: SubagentModelRef;
		commit?: SubagentModelRef;
	};
}

export interface MagpieConfig {
	modes: Record<string, ModeConfig | undefined>;
	aliases?: Record<string, string>;
	subagents: {
		default?: SubagentModelRef;
		search?: SubagentModelRef;
		oracle?: SubagentModelRef;
		librarian?: SubagentModelRef;
		plan?: {
			explore?: SubagentModelRef;
			design?: SubagentModelRef;
			risk?: SubagentModelRef;
			custom?: SubagentModelRef;
		};
		handoff?: SubagentModelRef;
		session?: SubagentModelRef;
		memory?: SubagentModelRef;
		titling?: SubagentModelRef;
		lookAt?: SubagentModelRef;
		commit?: SubagentModelRef;
		custom?: SubagentModelRef;
	};
	handoff?: {
		defaultMode?: HandoffDefaultMode;
	};
	sessions?: {
		autoIndex?: boolean;
		maxIndexEntries?: number;
	};
	memory?: {
		enabled?: boolean;
		maxRetrieved?: number;
		storePath?: string;
		autoExtract?: boolean;
	};
	web?: {
		searchModel?: string;
		searchTimeout?: number;
		fetchTimeout?: number;
	};
}

export interface ResolvedSubagentModel {
	model: string;
	thinkingLevel?: ThinkingLevel;
	prompt?: PromptConfig;
}

export interface ResolvedMode extends ModeConfig {
	name: string;
	statusLabel: string;
	planBehavior: PlanBehavior;
}
