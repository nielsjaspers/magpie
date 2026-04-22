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
	hostUrl?: string;
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

export interface RemoteHostConfig {
	tailscaleUrl?: string;
	publicUrl?: string;
	deviceToken?: string;
}

export interface RemoteConfig {
	mode?: "client" | "server" | "both";
	serverPort?: number;
	maxTarSize?: number;
	defaultHost?: string;
	hosts?: Record<string, RemoteHostConfig>;
	tarExclude?: string[];
}

export interface WebUiConfig {
	enabled?: boolean;
	port?: number;
	bind?: "tailscale" | "public" | "localhost" | string;
	publicUrl?: string;
	tailscaleUrl?: string;
	tls?: {
		certPath: string;
		keyPath: string;
	};
}

export interface ScheduleConfig {
	notifier?: "macos" | "telegram" | "none";
	telegram?: {
		botToken?: string;
		chatId?: string;
	};
}

export interface PreferencesConfig {
	enabled?: boolean;
	maxRetrieved?: number;
	storePath?: string;
	autoExtract?: boolean;
}

export interface MemoryConfig {
	rootDir?: string;
	autodream?: {
		enabled?: boolean;
		schedule?: string;
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
		schedule?: SubagentModelRef;
		custom?: SubagentModelRef;
	};
	handoff?: {
		defaultMode?: HandoffDefaultMode;
	};
	sessions?: {
		autoIndex?: boolean;
		maxIndexEntries?: number;
	};
	preferences?: PreferencesConfig;
	memory?: MemoryConfig;
	web?: {
		searchModel?: string;
		searchTimeout?: number;
		fetchTimeout?: number;
	};
	research?: ResearchConfig;
	personalAssistant?: PersonalAssistantConfig;
	telegram?: TelegramConfig;
	remote?: RemoteConfig;
	webui?: WebUiConfig;
	schedule?: ScheduleConfig;
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
