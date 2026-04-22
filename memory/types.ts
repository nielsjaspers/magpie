export interface MemoryAutodreamConfig {
	enabled?: boolean;
	schedule?: string;
}

export interface MemoryConfig {
	rootDir?: string;
	autodream?: MemoryAutodreamConfig;
}
