export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PromptStrategy = "append" | "replace";
export type HandoffDefaultMode = "default" | "plan";

export interface PromptConfig {
	strategy?: PromptStrategy;
	text?: string;
	file?: string;
}

export interface WorkerModelConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	prompt?: PromptConfig;
}

export type WorkerModelRef = string | WorkerModelConfig;
export type SubagentModelRef = WorkerModelRef;

export interface ModeConfig {
	skills?: string[];
	tools?: string[];
	hideTools?: string[];
	statusLabel?: string;
}

export interface ResearchConfig {
	papersDir?: string;
	resolverSubagent?: WorkerModelRef;
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
	model?: WorkerModelRef;
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
	model?: WorkerModelRef;
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
	remote?: RemoteConfig;
}

export interface MagpieConfig {
	modes?: Record<string, ModeConfig | undefined>;
	delegate?: WorkerModelRef;
	handoff?: {
		defaultMode?: HandoffDefaultMode;
		model?: WorkerModelRef;
	};
	sessions?: {
		autoIndex?: boolean;
		maxIndexEntries?: number;
		model?: WorkerModelRef;
	};
	commit?: {
		model?: WorkerModelRef;
	};
	btw?: {
		model?: WorkerModelRef;
	};
	web?: {
		searchModel?: string;
		searchTimeout?: number;
		fetchTimeout?: number;
	};
	preferences?: PreferencesConfig;
	memory?: MemoryConfig;
	research?: ResearchConfig;
	personalAssistant?: PersonalAssistantConfig;
	telegram?: TelegramConfig;
	remote?: RemoteConfig;
	webui?: WebUiConfig;
	schedule?: ScheduleConfig;
}

export interface ResolvedSubagentModel {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	prompt?: PromptConfig;
}

export interface ResolvedMode extends ModeConfig {
	name: string;
	statusLabel?: string;
}
