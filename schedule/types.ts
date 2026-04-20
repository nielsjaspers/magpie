export type ScheduleBackend = "at" | "cron_fallback";
export type ScheduleType = "one-shot";

export interface ScheduleRunState {
	startedAt?: string;
	endedAt?: string;
	exitCode?: number;
	resultPath: string;
}

export interface ScheduleEntry {
	id: string;
	type: ScheduleType;
	cwd: string;
	task: string;
	model?: string;
	mode?: string;
	when: string;
	runAt: string;
	backend: ScheduleBackend;
	scriptPath: string;
	resultPath: string;
	statePath: string;
	createdAt: string;
	notify: boolean;
	atJobId?: string;
	cronId?: string;
	cancelledAt?: string;
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
