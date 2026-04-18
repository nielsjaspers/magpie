import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadAuthConfig, loadConfig, getResearchPapersDir } from "../config/config.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { buildDigestContextMessage, DIGEST_CONTEXT_TYPE, getActiveDigestContext, loadDigestPrompt, persistActiveDigestSession, resolveDigestPaper } from "./digest.js";
import { fetchPaperMarkdown, searchSemanticScholar } from "./providers.js";
import { countExistingDigestSessions, ensureDigestFiles, formatPapersSummary, makePaperShortId, readStoredPaper, savePaper, toStoredMetadata, writeDigestSession } from "./storage.js";
import type { NormalizedPaper, StoredPaperRecord } from "./types.js";

const PAPERS_MESSAGE_TYPE = "magpie:research-papers";
const RESEARCH_STATUS_MESSAGE_TYPE = "magpie:research-status";
const RESEARCH_DIGEST_WIDGET_KEY = "magpie-research-digest";

function parsePapersArgs(input: string | undefined): { query: string; limit: number } {
	let remaining = input?.trim() ?? "";
	let limit = 10;
	const match = remaining.match(/(?:^|\s)-{1,2}limit\s+(\d+)/i);
	if (match) {
		limit = Math.min(Math.max(Number(match[1]), 1), 20);
		remaining = remaining.replace(match[0], " ").trim();
	}
	return { query: remaining, limit };
}

function renderPapersProgress(input: {
	query: string;
	phase?: string;
	rateLimit?: { attempt: number; maxAttempts: number; waitMs: number };
}): string[] {
	const lines = [`Searching papers for: ${input.query}`];
	if (input.phase) lines.push(`  ${input.phase}`);
	if (input.rateLimit) {
		lines.push(`  Semantic Scholar rate-limited, retry ${input.rateLimit.attempt}/${input.rateLimit.maxAttempts}`);
		lines.push(`  waiting ${(input.rateLimit.waitMs / 1000).toFixed(1)}s before retry`);
	}
	return lines;
}

function summarizeCandidates(candidates: StoredPaperRecord[]): string {
	return candidates.map((candidate, index) => {
		const firstAuthor = candidate.metadata.authors[0] || "Unknown author";
		return `${index + 1}. ${candidate.metadata.short_id} | ${candidate.metadata.title} | ${firstAuthor} | ${candidate.metadata.year ?? "n.d."}`;
	}).join("\n");
}

function renderResolverProgress(query: string, progressText?: string, tools?: string[]): string[] {
	const lines = [`Resolving paper for: ${query}`];
	for (const tool of tools?.slice(-4) ?? []) lines.push(`  → ${tool}`);
	if (progressText?.trim()) lines.push(`  ${progressText.trim().split("\n")[0]}`);
	return lines;
}

function renderDigestStartWidget(input: {
	title: string;
	firstAuthor?: string;
	shortId: string;
	sessionFile: string;
	priorSessionCount: number;
}): string[] {
	return [
		"/digest",
		`  paper: ${input.title}`,
		`  author: ${input.firstAuthor || "Unknown"}`,
		`  short_id: ${input.shortId}`,
		`  prior sessions: ${input.priorSessionCount}`,
		`  mode: ${input.priorSessionCount > 0 ? "continuing existing work" : "starting fresh"}`,
		`  session file: ${input.sessionFile}`,
	];
}

function normalizePaperShortIds(papers: NormalizedPaper[]): NormalizedPaper[] {
	return papers.map((paper) => ({ ...paper, shortId: makePaperShortId({ title: paper.title, authors: paper.authors, year: paper.year }) }));
}

function getLatestDigestMessageIndex(messages: Array<{ role?: string; customType?: string }>): number {
	let latest = -1;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message?.role === "custom" && message.customType === DIGEST_CONTEXT_TYPE) latest = i;
	}
	return latest;
}

async function selectDigestCandidate(ctx: ExtensionCommandContext, candidates: StoredPaperRecord[]): Promise<StoredPaperRecord | null> {
	if (!ctx.hasUI) return null;
	const options = candidates.map((candidate) => `${candidate.metadata.short_id} | ${candidate.metadata.title}`);
	const chosen = await ctx.ui.select("Which paper did you mean?", options);
	if (!chosen) return null;
	return candidates[options.indexOf(chosen)] ?? null;
}

export default function (pi: ExtensionAPI) {
	let subagentCore: SubagentCoreAPI | null = null;
	pi.events.on("magpie:subagent-core:register", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});
	pi.events.emit("magpie:subagent-core:get", (api: SubagentCoreAPI) => {
		subagentCore = api;
	});

	pi.on("context", (event) => {
		const latestDigestIndex = getLatestDigestMessageIndex(event.messages as Array<{ role?: string; customType?: string }>);
		if (latestDigestIndex < 0) return;
		return {
			messages: event.messages.filter((message: any, index: number) => !(message.role === "custom" && message.customType === DIGEST_CONTEXT_TYPE && index !== latestDigestIndex)),
		};
	});

	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		if (!getActiveDigestContext(ctx.sessionManager.getBranch())) return;
		const prompt = await loadDigestPrompt();
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		await persistActiveDigestSession(ctx);
		ctx.ui.setWidget(RESEARCH_DIGEST_WIDGET_KEY, undefined);
	});

	pi.registerCommand("papers", {
		description: "Search Semantic Scholar and save papers locally (-limit <1-20>)",
		handler: async (args, ctx) => {
			const { query, limit } = parsePapersArgs(args);
			if (!query) {
				ctx.ui.notify("Usage: /papers [-limit <1-20>] <query>", "warning");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const auth = await loadAuthConfig(ctx.cwd);
			const papersDir = getResearchPapersDir(config);
			ctx.ui.setWidget("magpie-research-papers", renderPapersProgress({ query, phase: `limit: ${limit}` }), { placement: "aboveEditor" });
			try {
				const normalized = normalizePaperShortIds(await searchSemanticScholar(query, limit, {
					apiKey: auth.semanticScholar?.apiKey,
					onRateLimit: ({ attempt, maxAttempts, waitMs }) => {
						ctx.ui.setWidget("magpie-research-papers", renderPapersProgress({
							query,
							rateLimit: { attempt, maxAttempts, waitMs },
						}), { placement: "aboveEditor" });
					},
				}));
				if (normalized.length === 0) {
					pi.sendMessage({
						customType: RESEARCH_STATUS_MESSAGE_TYPE,
						content: `No papers found for: ${query}`,
						display: true,
						details: { query },
					}, { triggerTurn: false });
					return;
				}
				const savedRecords: StoredPaperRecord[] = [];
				const existingShortIds: string[] = [];
				for (const paper of normalized) {
					const existing = await readStoredPaper(papersDir, paper.shortId);
					if (existing) {
						savedRecords.push(existing);
						existingShortIds.push(existing.metadata.short_id);
						continue;
					}
					const fetchedAt = new Date().toISOString();
					const fetchResult = await fetchPaperMarkdown(paper);
					const metadata = toStoredMetadata(paper, fetchedAt, fetchResult);
					const saved = await savePaper(papersDir, metadata, fetchResult.markdown);
					savedRecords.push(saved);
				}
				const summary = formatPapersSummary(savedRecords);
				const existingNote = existingShortIds.length > 0
					? `\n\nAlready stored and left unchanged: ${existingShortIds.join(", ")}`
					: "";
				pi.sendMessage({
					customType: PAPERS_MESSAGE_TYPE,
					content: `# /papers\n\nQuery: ${query}\nLimit: ${limit}\nDirectory: ${papersDir}\n\n${summary}${existingNote}`,
					display: true,
					details: { query, limit, papersDir, records: savedRecords.map((record) => record.metadata) },
				}, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				ctx.ui.setWidget("magpie-research-papers", undefined);
			}
		},
	});

	pi.registerCommand("digest", {
		description: "Start a Socratic digest session for a saved paper",
		handler: async (args, ctx) => {
			const query = args?.trim() ?? "";
			if (!query) {
				ctx.ui.notify("Usage: /digest <query>", "warning");
				return;
			}
			if (!subagentCore) {
				ctx.ui.notify("Subagent core unavailable.", "error");
				return;
			}
			const config = await loadConfig(ctx.cwd);
			const papersDir = getResearchPapersDir(config);
			let startedDigest = false;
			ctx.ui.setWidget(RESEARCH_DIGEST_WIDGET_KEY, renderResolverProgress(query), { placement: "aboveEditor" });
			try {
				const resolved = await resolveDigestPaper(ctx, config, subagentCore, papersDir, query, (progress) => {
					ctx.ui.setWidget(
						RESEARCH_DIGEST_WIDGET_KEY,
						renderResolverProgress(query, progress.partialOutput, progress.toolCalls.map((call) => call.name)),
						{ placement: "aboveEditor" },
					);
				});
				if (resolved.kind === "none") {
					pi.sendMessage({
						customType: RESEARCH_STATUS_MESSAGE_TYPE,
						content: `No saved paper matched: ${query}\n\nRun /papers first, or try a more specific query.`,
						display: true,
						details: { query },
					}, { triggerTurn: false });
					return;
				}
				let record: StoredPaperRecord | null = null;
				if (resolved.kind === "many") {
					record = await selectDigestCandidate(ctx, resolved.candidates);
					if (!record) {
						pi.sendMessage({
							customType: RESEARCH_STATUS_MESSAGE_TYPE,
							content: `Multiple papers matched: ${query}\n\n${summarizeCandidates(resolved.candidates)}`,
							display: true,
							details: { query, candidates: resolved.candidates.map((candidate) => candidate.metadata) },
						}, { triggerTurn: false });
						return;
					}
				} else {
					record = resolved.paper;
				}
				if (!record.paperMarkdown?.trim()) {
					pi.sendMessage({
						customType: RESEARCH_STATUS_MESSAGE_TYPE,
						content: `Paper markdown is unavailable for ${record.metadata.short_id}. Re-run /papers for this query after fixing extraction, or fetch an accessible HTML source.`,
						display: true,
						details: { shortId: record.metadata.short_id },
					}, { triggerTurn: false });
					return;
				}
				const priorSessionCount = await countExistingDigestSessions(papersDir, record.metadata.short_id);
				const startedAt = new Date();
				const digestFiles = await ensureDigestFiles(papersDir, record.metadata.short_id, startedAt);
				await writeDigestSession(digestFiles.sessionFile, [
					"# Digest Session",
					"",
					`- Paper: ${record.metadata.title}`,
					`- Short ID: ${record.metadata.short_id}`,
					`- Started: ${startedAt.toISOString()}`,
					"",
					"## Transcript",
				].join("\n"));
				const details = {
					runId: crypto.randomUUID(),
					shortId: record.metadata.short_id,
					title: record.metadata.title,
					firstAuthor: record.metadata.authors[0],
					paperDir: digestFiles.paperDir,
					sessionFile: digestFiles.sessionFile,
					answersFile: digestFiles.answersPath,
					startedAt: startedAt.toISOString(),
				};
				const kickoff = await buildDigestContextMessage(record, digestFiles.sessionFile, digestFiles.answersPath);
				ctx.ui.setWidget(RESEARCH_DIGEST_WIDGET_KEY, renderDigestStartWidget({
					title: record.metadata.title,
					firstAuthor: record.metadata.authors[0],
					shortId: record.metadata.short_id,
					sessionFile: digestFiles.sessionFile,
					priorSessionCount,
				}), { placement: "aboveEditor" });
				pi.sendMessage({
					customType: RESEARCH_STATUS_MESSAGE_TYPE,
					content: `Starting /digest for ${record.metadata.title} (${record.metadata.short_id})`,
					display: true,
					details: { shortId: record.metadata.short_id, sessionFile: digestFiles.sessionFile, priorSessionCount },
				}, { triggerTurn: false });
				startedDigest = true;
				pi.sendMessage({
					customType: DIGEST_CONTEXT_TYPE,
					content: kickoff,
					display: false,
					details,
				}, { triggerTurn: true, deliverAs: "nextTurn" });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (!startedDigest) ctx.ui.setWidget(RESEARCH_DIGEST_WIDGET_KEY, undefined);
			}
		},
	});
}
