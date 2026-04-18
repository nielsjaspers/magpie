import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { MagpieConfig } from "../config/types.js";
import { getResearchResolverSubagent } from "../config/config.js";
import type { SubagentCoreAPI } from "../subagents/types.js";
import { rebuildAnswersFile, readStoredPaper, writeDigestSession } from "./storage.js";
import type { DigestContextDetails, DigestResolutionResult, StoredPaperRecord } from "./types.js";

export const DIGEST_CONTEXT_TYPE = "magpie:research-digest-context";

const DIGEST_PROMPT_PATH = fileURLToPath(new URL("./digest-prompt.md", import.meta.url));
let promptCache: string | null = null;

function messageToText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as any).type === "text" && typeof (block as any).text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function buildResolverSystemPrompt(baseDir: string): string {
	return [
		"You are an internal paper resolver for Magpie's /digest command.",
		"Your only job is to identify which previously saved paper the user is referencing.",
		`Search only under this papers directory: ${baseDir}`,
		"Read metadata.json files and compare the user query against title, authors, abstract, TLDR, venue, DOI, and arXiv identifiers.",
		"Return exactly one JSON object and nothing else.",
		"Schema:",
		'{ "kind": "none" }',
		'or { "kind": "one", "short_id": "..." }',
		'or { "kind": "many", "candidates": [{ "short_id": "...", "title": "...", "reason": "..." }] }',
		"If there are multiple plausible contenders, do not guess. Return kind=many.",
		"Do not search the wider repo. Do not propose next steps. Do not explain beyond the JSON fields.",
	].join("\n");
}

export async function loadDigestPrompt(): Promise<string> {
	if (promptCache !== null) return promptCache;
	promptCache = (await readFile(DIGEST_PROMPT_PATH, "utf8")).trim();
	return promptCache;
}

export async function resolveDigestPaper(
	ctx: ExtensionContext,
	config: MagpieConfig,
	subagentCore: SubagentCoreAPI,
	baseDir: string,
	query: string,
): Promise<DigestResolutionResult> {
	const resolver = getResearchResolverSubagent(config);
	const result = await subagentCore.runSubagent(ctx, config, {
		role: "custom",
		label: "research-resolver",
		task: `User query: ${query.trim()}`,
		systemPrompt: buildResolverSystemPrompt(baseDir),
		model: resolver?.model,
		thinkingLevel: resolver?.thinkingLevel,
		tools: "readonly",
	});
	if (result.exitCode !== 0 || !result.output.trim()) return { kind: "none" };
	let parsed: any;
	try {
		parsed = JSON.parse(result.output.trim());
	} catch {
		return { kind: "none" };
	}
	if (parsed?.kind === "one" && typeof parsed.short_id === "string") {
		const paper = await readStoredPaper(baseDir, parsed.short_id);
		return paper ? { kind: "one", paper } : { kind: "none" };
	}
	if (parsed?.kind === "many" && Array.isArray(parsed.candidates)) {
		const candidates: StoredPaperRecord[] = [];
		for (const candidate of parsed.candidates.slice(0, 8)) {
			if (typeof candidate?.short_id !== "string") continue;
			const paper = await readStoredPaper(baseDir, candidate.short_id);
			if (paper) candidates.push(paper);
		}
		return candidates.length > 0 ? { kind: "many", candidates } : { kind: "none" };
	}
	return { kind: "none" };
}

export async function buildDigestContextMessage(record: StoredPaperRecord, sessionFile: string, answersFile: string): Promise<string> {
	const priorAnswers = existsSync(answersFile) ? (await readFile(answersFile, "utf8")).trim() : "";
	const paperMarkdown = record.paperMarkdown?.trim() || "";
	return [
		"[DIGEST SESSION CONTEXT]",
		`Paper title: ${record.metadata.title}`,
		`First author: ${record.metadata.authors[0] || "Unknown"}`,
		`Short ID: ${record.metadata.short_id}`,
		`Digest session file: ${sessionFile}`,
		"If this branch already contains digest questions and answers, continue from that conversation rather than restarting it.",
		"Only ask the intensity calibration question if it has not already been asked in this branch.",
		priorAnswers ? `Prior answers:\n${priorAnswers}` : "Prior answers: none.",
		paperMarkdown ? `Paper markdown:\n${paperMarkdown}` : "Paper markdown unavailable.",
	].join("\n\n");
}

function latestDigestMarker(branch: SessionEntry[]): (SessionEntry & { type: "custom_message"; details?: DigestContextDetails; customType: string }) | undefined {
	return [...branch]
		.reverse()
		.find((entry): entry is SessionEntry & { type: "custom_message"; details?: DigestContextDetails; customType: string } => entry.type === "custom_message" && entry.customType === DIGEST_CONTEXT_TYPE);
}

export function getActiveDigestContext(branch: SessionEntry[]): { markerId: string; details: DigestContextDetails } | undefined {
	const marker = latestDigestMarker(branch);
	if (!marker?.details) return undefined;
	return { markerId: marker.id, details: marker.details };
}

function isDigestMessage(message: AgentMessage): message is AgentMessage & { role: "user" | "assistant" } {
	return (message as any).role === "user" || (message as any).role === "assistant";
}

export function buildDigestSessionMarkdown(branch: SessionEntry[], active: { markerId: string; details: DigestContextDetails }): string {
	const markerIndex = branch.findIndex((entry) => entry.id === active.markerId);
	const transcriptEntries = (markerIndex >= 0 ? branch.slice(markerIndex + 1) : branch)
		.filter((entry): entry is SessionEntry & { type: "message"; message: AgentMessage } => entry.type === "message")
		.map((entry) => entry.message)
		.filter(isDigestMessage);
	const blocks: string[] = [
		`# Digest Session`,
		"",
		`- Paper: ${active.details.title}`,
		`- Short ID: ${active.details.shortId}`,
		`- Started: ${active.details.startedAt}`,
		"",
		`## Transcript`,
		"",
	];
	for (const message of transcriptEntries) {
		const text = messageToText(message);
		if (!text) continue;
		blocks.push(`## ${message.role === "assistant" ? "Assistant" : "User"}`);
		blocks.push("");
		blocks.push(text.trim());
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

export async function persistActiveDigestSession(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	const active = getActiveDigestContext(branch);
	if (!active) return;
	const sessionMarkdown = buildDigestSessionMarkdown(branch, active);
	await writeDigestSession(active.details.sessionFile, sessionMarkdown);
	await rebuildAnswersFile(dirname(active.details.sessionFile), active.details.answersFile);
}
