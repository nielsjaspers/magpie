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
	disableTools?: string[];
	prompt?: ModePromptConfig;
	planBehavior?: PlanBehavior;
	subagents?: {
		search?: SubagentModelRef;
		oracle?: SubagentModelRef;
		librarian?: SubagentModelRef;
		commit?: SubagentModelRef;
	};
}

export interface ResearchConfig {
	papersDir?: string;
	resolverSubagent?: SubagentModelRef;
}

export interface PersonalAssistantConfig {
	timezone?: string;
	storageDir?: string;
	calendar?: {
		defaultWritableCalendar?: string;
	};
}

export interface TelegramConfig {
	allowFrom?: string[];
	models?: Record<string, string>;
	showToolCalls?: boolean;
	prompt?: {
		systemFile?: string;
		memoryFile?: string;
		userFile?: string;
		customFiles?: string[];
	};
}

export interface ProviderAuthConfig {
	apiKey?: string;
}

export interface PersonalAssistantAuthConfig {
	calendar?: {
		icloud?: {
			email?: string;
			appPassword?: string;
		};
		icsFeeds?: Array<{
			id?: string;
			name?: string;
			url?: string;
		}>;
	};
	mail?: {
		gmail?: {
			address?: string;
			appPassword?: string;
		};
	};
}

export interface MagpieAuthConfig {
	semanticScholar?: ProviderAuthConfig;
	exa?: ProviderAuthConfig;
	personalAssistant?: PersonalAssistantAuthConfig;
	telegram?: {
		botToken?: string;
	};
}

export interface MagpieConfig {
	startupMode?: string;
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
	research?: ResearchConfig;
	personalAssistant?: PersonalAssistantConfig;
	telegram?: TelegramConfig;
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
