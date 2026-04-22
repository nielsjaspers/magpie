import type { MagpieConfig, ModeConfig } from "./types.js";

export const SMART_PROMPT = `You are in Smart mode.
Be collaborative, evidence-driven, and balanced. Create structured plans for non-trivial tasks and track progress as you go. Read files before editing. Mimic existing code style. Run lint/typecheck after changes. Be concise.`;

export const RUSH_PROMPT = `You are in Rush mode.
Optimize for speed. Skip formal planning. Go straight to implementation. Keep responses short. Do not explain unless asked. If the task is more complex than expected, say so rather than burning tokens.`;

export const DEEP_PROMPT = `You are in Deep mode.
Investigate thoroughly before acting. Trace call chains, examine dependencies, surface assumptions explicitly. Create a structured plan with phases: research, design, implementation, validation. Run all tests after changes.`;

export const LEARN_PROMPT = `You are in Learning mode.
Balance task completion with education. Provide brief codebase-specific insights using the ★ Insight format. For substantial code (20+ lines), use TODO(human) markers to invite user participation on meaningful decisions.`;

export const BUILT_IN_MODES: Record<string, ModeConfig> = {
	smart: {
		statusLabel: "smart",
		model: "opencode-go/mimo-v2-pro",
		thinkingLevel: "high",
		prompt: { strategy: "append", text: SMART_PROMPT },
		planBehavior: "none",
	},
	rush: {
		statusLabel: "⚡ rush",
		model: "github-copilot/gpt-5.4-mini",
		thinkingLevel: "low",
		prompt: { strategy: "append", text: RUSH_PROMPT },
		planBehavior: "none",
	},
	deep: {
		statusLabel: "🧠 deep",
		model: "github-copilot/gpt-5.3-codex",
		thinkingLevel: "xhigh",
		prompt: { strategy: "append", text: DEEP_PROMPT },
		planBehavior: "none",
	},
	learn: {
		statusLabel: "🎓 learn",
		prompt: { strategy: "append", text: LEARN_PROMPT },
		planBehavior: "none",
	},
};

export const DEFAULT_CONFIG: MagpieConfig = {
	startupMode: "smart",
	modes: { ...BUILT_IN_MODES },
	aliases: {
		fast: "rush",
		careful: "deep",
		study: "learn",
	},
	subagents: {
		default: "opencode-go/minimax-m2.7",
		search: "opencode-go/mimo-v2-pro",
		oracle: { model: "github-copilot/gpt-5.3-codex", thinkingLevel: "high" },
		librarian: { model: "opencode-go/mimo-v2-pro", thinkingLevel: "medium" },
		plan: {
			explore: { model: "github-copilot/gpt-5.4-mini", thinkingLevel: "low" },
			design: "opencode-go/glm-5.1",
			risk: "opencode-go/mimo-v2-pro",
			custom: "github-copilot/gpt-5-mini",
		},
		handoff: "opencode-go/mimo-v2-pro",
		session: { model: "github-copilot/gpt-5-mini", thinkingLevel: "minimal" },
		memory: { model: "github-copilot/gpt-5-mini", thinkingLevel: "minimal" },
		commit: { model: "github-copilot/gpt-5-mini", thinkingLevel: "low" },
		schedule: { model: "github-copilot/gpt-5-mini", thinkingLevel: "low" },
		custom: "github-copilot/gpt-5-mini",
	},
	handoff: {
		defaultMode: "default",
	},
	sessions: {
		autoIndex: true,
		maxIndexEntries: 500,
	},
	preferences: {
		enabled: true,
		maxRetrieved: 20,
		autoExtract: false,
	},
	memory: {
		rootDir: "~/.pi/agent/magpie-memory",
		autodream: {
			enabled: true,
			schedule: "0 4 * * *",
		},
	},
	web: {
		searchModel: "opencode-go/minimax-m2.7",
		searchTimeout: 120000,
		fetchTimeout: 30000,
	},
	research: {
		papersDir: "~/magpie-papers",
		resolverSubagent: {
			model: "github-copilot/gpt-5-mini",
			thinkingLevel: "low",
		},
	},
	personalAssistant: {
		timezone: "Europe/Amsterdam",
		storageDir: "~/.pi/agent/personal-assistant",
		calendar: {},
	},
	telegram: {
		hostUrl: "http://127.0.0.1:8787",
		allowFrom: [],
		models: {},
		showToolCalls: false,
		prompt: {
			systemFile: "telegram/SYSTEM.md",
			memoryFile: "telegram/MEMORY.md",
			userFile: "telegram/USER.md",
			customFiles: [],
		},
	},
	remote: {
		mode: "client",
		serverPort: 4711,
		maxTarSize: 524288000,
		defaultHost: undefined,
		hosts: {},
		tarExclude: ["node_modules", ".pi/sessions", "dist", "build", ".venv", "__pycache__", ".git"],
	},
	webui: {
		enabled: false,
		port: 8787,
		bind: "localhost",
	},
	schedule: {},
};
