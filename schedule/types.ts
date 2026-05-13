import type { ThinkingLevel } from "../config/types.js";

export type ScheduleBackend = "at" | "cron_fallback";
export type ScheduleType = "one-shot" | "recurring";
export type ScheduleExtensionMode = "builtin" | "magpie";

export type ScheduleNotifier =
	| { kind: "none" }
	| { kind: "macos" }
	| { kind: "telegram"; botToken: string; chatId: string };

export interface ScheduleRuntimeOptions {
	mode?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: { strategy: "append" | "replace"; text: string };
	notifier: ScheduleNotifier;
	sessionRootDir: string;
	extensionMode: ScheduleExtensionMode;
}

export interface ParsedScheduleRequest {
	type: ScheduleType;
	when: string;
	runAt?: string;
	cronExpr?: string;
}

export interface ScheduleTaskInput {
	when: string;
	task: string;
	model?: string;
	mode?: string;
	cwd?: string;
	notify?: boolean;
	extensionMode?: ScheduleExtensionMode;
	preferredNotifier?: "telegram" | "macos" | "none";
}

export interface ScheduleRunRecord {
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	resultPath: string;
	statePath?: string;
	sessionDir?: string;
}

export interface ScheduleRunState {
	startedAt?: string;
	endedAt?: string;
	exitCode?: number;
	resultPath: string;
	sessionDir?: string;
}

export interface ScheduleEntry {
	id: string;
	type: ScheduleType;
	cwd: string;
	task: string;
	model?: string;
	mode?: string;
	when: string;
	runAt?: string;
	cronExpr?: string;
	backend: ScheduleBackend;
	scriptPath: string;
	resultPath?: string;
	statePath?: string;
	sessionDir?: string;
	createdAt: string;
	notify: boolean;
	atJobId?: string;
	cronId?: string;
	cancelledAt?: string;
	runs: ScheduleRunRecord[];
}

export interface ScheduleStore {
	baseDir: string;
	scriptsDir: string;
	resultsDir: string;
	indexPath: string;
}

export interface ScheduleConfig {
	notifier?: "macos" | "telegram" | "none";
	telegram?: {
		botToken?: string;
		chatId?: string;
	};
}
