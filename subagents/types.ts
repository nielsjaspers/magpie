export type SubagentRole =
	| "search"
	| "oracle"
	| "librarian"
	| "plan"
	| "handoff"
	| "session"
	| "memory"
	| "titling"
	| "lookAt"
	| "commit"
	| "custom";

export interface SubagentSpec {
	role: SubagentRole;
	planSubRole?: "explore" | "design" | "risk" | "custom";
	label: string;
	task: string;
	systemPrompt?: string;
	model?: string;
	thinkingLevel?: string;
	tools?: "readonly" | "full" | string[];
	context?: string;
	maxTurns?: number;
	timeout?: number;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export interface SubagentProgress {
	turns: number;
	toolCalls: Array<{ name: string; args: Record<string, any> }>;
	partialOutput: string;
	usage: UsageStats;
}

export interface SubagentResult {
	spec: SubagentSpec;
	output: string;
	displayItems: DisplayItem[];
	exitCode: number;
	usage: UsageStats;
	model: string;
	errorMessage?: string;
	stopReason?: string;
}

export interface SubagentCoreAPI {
	runSubagent: typeof import("./core.js").runSubagent;
	runSubagentBatch: typeof import("./core.js").runSubagentBatch;
}
