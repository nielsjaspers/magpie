import type { NormalizedPaper, PaperFetchResult } from "./types.js";

const SEMANTIC_SCHOLAR_FIELDS = [
	"paperId",
	"title",
	"abstract",
	"authors",
	"year",
	"citationCount",
	"openAccessPdf",
	"externalIds",
	"venue",
	"tldr",
	"url",
].join(",");

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExternalId(externalIds: Record<string, unknown> | undefined, target: string): string | undefined {
	if (!externalIds) return undefined;
	for (const [key, value] of Object.entries(externalIds)) {
		if (key.toLowerCase() === target.toLowerCase() && typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isUsableMarkdown(markdown: string | undefined): markdown is string {
	const trimmed = markdown?.trim();
	return Boolean(trimmed && trimmed.length >= 200 && /\S/.test(trimmed));
}

function normalizeArxivId(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const trimmed = value.trim();
	const urlMatch = trimmed.match(/arxiv\.org\/(?:abs|html)\/([^?#/]+)/i);
	if (urlMatch?.[1]) return urlMatch[1];
	return trimmed.replace(/^arxiv:/i, "");
}

function getDefuddleUrl(paper: Omit<NormalizedPaper, "shortId"> & { shortId?: string }): string | undefined {
	const arxivId = normalizeArxivId(paper.arxivId);
	if (arxivId) return `https://arxiv.org/html/${arxivId}`;
	if (paper.url?.trim()) return paper.url.trim();
	if (paper.openAccessPdf?.trim() && !/\.pdf(?:$|[?#])/i.test(paper.openAccessPdf)) return paper.openAccessPdf.trim();
	return undefined;
}

async function fetchText(url: string, init?: RequestInit, timeoutMs = 30000): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
		return await response.text();
	} finally {
		clearTimeout(timeout);
	}
}

export async function searchSemanticScholar(query: string, limit: number): Promise<NormalizedPaper[]> {
	const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
	const params = new URLSearchParams({
		query,
		limit: String(limit),
		fields: SEMANTIC_SCHOLAR_FIELDS,
	});
	const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
	let attempt = 0;
	while (attempt < 4) {
		attempt += 1;
		const response = await fetch(url, {
			headers: apiKey ? { "x-api-key": apiKey } : undefined,
		});
		if (response.status === 429 && attempt < 4) {
			await sleep(500 * 2 ** (attempt - 1));
			continue;
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Semantic Scholar search failed (${response.status}): ${body || response.statusText}`);
		}
		const json = await response.json() as { data?: any[] };
		const papers = (json.data ?? []).map((paper) => {
			const externalIds = (paper.externalIds && typeof paper.externalIds === "object") ? paper.externalIds as Record<string, unknown> : undefined;
			return {
				shortId: "",
				title: typeof paper.title === "string" ? paper.title.trim() : "Untitled paper",
				authors: Array.isArray(paper.authors) ? paper.authors.map((author: any) => typeof author?.name === "string" ? author.name.trim() : "").filter(Boolean) : [],
				year: typeof paper.year === "number" ? paper.year : undefined,
				venue: typeof paper.venue === "string" ? paper.venue.trim() : undefined,
				citationCount: typeof paper.citationCount === "number" ? paper.citationCount : undefined,
				tldr: typeof paper.tldr?.text === "string" ? paper.tldr.text.trim() : typeof paper.tldr === "string" ? paper.tldr.trim() : undefined,
				abstract: typeof paper.abstract === "string" ? paper.abstract.trim() : undefined,
				semanticScholarId: typeof paper.paperId === "string" ? paper.paperId : undefined,
				arxivId: normalizeArxivId(getExternalId(externalIds, "ArXiv")),
				doi: getExternalId(externalIds, "DOI"),
				url: typeof paper.url === "string" ? paper.url.trim() : undefined,
				openAccessPdf: typeof paper.openAccessPdf?.url === "string" ? paper.openAccessPdf.url.trim() : undefined,
			} satisfies NormalizedPaper;
		});
		return papers;
	}
	throw new Error("Semantic Scholar search exhausted retry budget.");
}

export async function fetchViaDefuddle(url: string): Promise<string | undefined> {
	const markdown = await fetchText(`https://defuddle.md/${url}`);
	return isUsableMarkdown(markdown) ? markdown : undefined;
}

export async function fetchViaArxiv2md(arxivId: string): Promise<string | undefined> {
	const id = normalizeArxivId(arxivId);
	if (!id) return undefined;
	const markdown = await fetchText(`https://arxiv2md.org/api/markdown?url=${encodeURIComponent(`https://arxiv.org/abs/${id}`)}`);
	return isUsableMarkdown(markdown) ? markdown : undefined;
}

export async function fetchPaperMarkdown(paper: NormalizedPaper): Promise<PaperFetchResult> {
	const defuddleUrl = getDefuddleUrl(paper);
	if (defuddleUrl) {
		try {
			const markdown = await fetchViaDefuddle(defuddleUrl);
			if (markdown) return { markdown, source: "defuddle" };
		} catch (error) {
			if (!paper.arxivId) {
				return { source: "none", error: error instanceof Error ? error.message : String(error) };
			}
		}
	}
	if (paper.arxivId) {
		try {
			const markdown = await fetchViaArxiv2md(paper.arxivId);
			if (markdown) return { markdown, source: "arxiv2md" };
			return { source: "none", error: "No usable markdown from arxiv2md." };
		} catch (error) {
			return { source: "none", error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { source: "none", error: defuddleUrl ? "No usable markdown from Defuddle." : "No supported paper URL found." };
}
