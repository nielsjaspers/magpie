import { isAbsolute, relative, resolve } from "node:path";

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*tree\b/,
	/^\s*git\s+(status|log|diff|show)/i,
	/^\s*npm\s+(list|ls)/i,
	/^\s*jq\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*curl\b/,
];

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function isSafeCommand(command: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

export function cleanStepText(text: string): string {
	let cleaned = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 77)}...`;
	return cleaned;
}

export function extractTodoItems(text: string): TodoItem[] {
	const items: TodoItem[] = [];
	for (const match of text.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)) {
		const cleaned = cleanStepText(match[2]);
		if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	return Array.from(message.matchAll(/\[DONE:(\d+)\]/gi)).map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const done = extractDoneSteps(text);
	for (const step of done) {
		const item = items.find((candidate) => candidate.step === step);
		if (item) item.completed = true;
	}
	return done.length;
}

export function slugify(input: string): string {
	const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return slug || "plan";
}

export function randomName(): string {
	const adjectives = ["amber", "bold", "calm", "deep", "frosty", "gentle", "rapid", "silent", "swift", "vast"];
	const nouns = ["bird", "brook", "crest", "field", "forest", "path", "river", "spark", "stone", "wind"];
	return `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

export function isPlanPath(pathArg: string, cwd: string): boolean {
	const abs = resolve(cwd, pathArg);
	const plansDir = resolve(cwd, ".pi/plans");
	const rel = relative(plansDir, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	return abs.endsWith(".plan.md");
}
