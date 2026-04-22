export interface MemoryEntry {
	id: string;
	content: string;
	createdAt: string;
	source: "user" | "auto";
	category?: string;
	active: boolean;
}

export interface PendingMemoryEntry {
	sessionPath: string;
	queuedAt: string;
	attempts: number;
}
