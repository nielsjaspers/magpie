import { isAbsolute, relative, resolve } from "node:path";

// Destructive commands blocked in plan mode
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
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 80) {
		cleaned = `${cleaned.slice(0, 77)}...`;
	}
	return cleaned;
}

export function extractTodoItems(text: string): TodoItem[] {
	const items: TodoItem[] = [];
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

	for (const match of text.matchAll(numberedPattern)) {
		const cleaned = cleanStepText(match[2]);
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug.length > 0 ? slug : "plan";
}

const ADJECTIVES = [
	"amber", "ancient", "aqua", "arctic", "autumn", "azure", "bare", "base", "billowing", "bitter",
	"black", "blue", "bold", "brave", "brief", "bright", "brisk", "broad", "broken", "bronze",
	"calm", "celestial", "cherry", "chill", "cold", "cool", "crimson", "crisp", "curved", "cyan",
	"dark", "dawn", "deep", "divine", "dry", "dull", "dusk", "dusty", "empty", "evening",
	"fading", "fast", "fierce", "flat", "floral", "flowing", "flying", "forest", "fragrant", "frosty",
	"gentle", "golden", "grand", "gray", "green", "hidden", "hollow", "holy", "icy", "indigo",
	"jade", "late", "lively", "long", "lost", "lunar", "magenta", "misty", "moonlit", "morning",
	"muddy", "mute", "mute", "navy", "noble", "noisy", "old", "pale", "patient", "peach",
	"proud", "purple", "quiet", "rapid", "red", "restless", "rough", "round", "royal", "ruby",
	"rustic", "sacred", "sapphire", "scarlet", "secret", "serene", "sharp", "shining", "silent", "silver",
	"simple", "sleek", "slow", "smooth", "soft", "solar", "solid", "sparkling", "spring", "square",
	"steep", "still", "stout", "strong", "summer", "sweet", "swift", "teal", "tight", "twilight",
	"vast", "velvet", "violet", "wandering", "warm", "white", "wild", "windy", "winter", "yellow"
];

const NOUNS = [
	"apple", "ash", "bird", "block", "boat", "breeze", "brook", "bush", "butterfly", "cake",
	"cape", "cave", "cell", "cherry", "cloud", "coast", "cove", "creek", "crest", "crow",
	"dawn", "day", "dew", "dream", "dusk", "dust", "eagle", "earth", "fall", "feather",
	"fern", "field", "fire", "fish", "flower", "fog", "forest", "fox", "frog", "frost",
	"glade", "glass", "grass", "grove", "hall", "hare", "hawk", "haze", "heart", "hill",
	"hound", "ice", "island", "king", "lake", "leaf", "light", "lion", "math", "meadow",
	"moon", "morning", "moth", "mountain", "night", "nightingale", "oak", "ocean", "owl", "paper",
	"path", "peak", "pine", "pine", "plain", "plant", "pond", "queen", "rain", "raven",
	"resonance", "river", "road", "rock", "rose", "sand", "sea", "shadow", "shape", "silence",
	"sky", "smoke", "snow", "sound", "spark", "spell", "spring", "star", "stone", "storm",
	"stream", "summer", "sun", "sunset", "surf", "surge", "swallow", "swan", "team", "thunder",
	"tide", "timber", "time", "tree", "truth", "valley", "voice", "water", "wave", "way",
	"willow", "wind", "winter", "wolf", "wood", "word", "world", "yew"
];

export function generateRandomName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	return `${adj}-${noun}`;
}

export function isPlanPath(pathArg: string, cwd: string): boolean {
	const abs = resolve(cwd, pathArg);
	const plansDir = resolve(cwd, ".pi/plans");
	const rel = relative(plansDir, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	return abs.endsWith(".plan.md");
}
