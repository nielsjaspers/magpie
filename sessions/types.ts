export interface SessionIndexEntry {
	sessionId: string;
	sessionPath: string;
	startedAt: string;
	endedAt: string;
	cwd: string;
	messageCount: number;
	modelsUsed: string[];
	summary: string;
	topics: string[];
	filesModified: string[];
}

export interface PendingIndexEntry {
	sessionPath: string;
	cwd: string;
	queuedAt: string;
	attempts: number;
}
