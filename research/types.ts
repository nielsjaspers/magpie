import type { ResolvedSubagentModel } from "../config/types.js";

export type ExtractorSource = "defuddle" | "arxiv2md" | "none";

export interface NormalizedPaper {
	shortId: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	citationCount?: number;
	tldr?: string;
	abstract?: string;
	semanticScholarId?: string;
	arxivId?: string;
	doi?: string;
	url?: string;
	openAccessPdf?: string;
}

export interface StoredPaperMetadata {
	short_id: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	citation_count?: number;
	tldr?: string;
	abstract?: string;
	semantic_scholar_id?: string;
	arxiv_id?: string;
	doi?: string;
	url?: string;
	open_access_pdf?: string;
	fetched_at: string;
	source: ExtractorSource;
	markdown_available: boolean;
	fetch_error?: string;
}

export interface StoredPaperRecord {
	metadata: StoredPaperMetadata;
	paperDir: string;
	metadataPath: string;
	paperPath: string;
	digestDir: string;
	answersPath: string;
	paperMarkdown?: string;
}

export interface PaperFetchResult {
	markdown?: string;
	source: ExtractorSource;
	error?: string;
}

export interface DigestContextDetails {
	runId: string;
	shortId: string;
	title: string;
	firstAuthor?: string;
	paperDir: string;
	sessionFile: string;
	answersFile: string;
	startedAt: string;
}

export type DigestResolutionResult =
	| { kind: "none" }
	| { kind: "one"; paper: StoredPaperRecord }
	| { kind: "many"; candidates: StoredPaperRecord[] };

export interface ResearchRuntimeConfig {
	papersDir: string;
	resolverSubagent?: ResolvedSubagentModel;
}
