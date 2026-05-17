import type { MagpieConfig, ModeConfig } from "./types.js";

export const BUILT_IN_MODES: Record<string, ModeConfig> = {
	plan: {
		statusLabel: "plan",
		skills: ["planning"],
	},
};

export const DEFAULT_CONFIG: MagpieConfig = {
	modes: { ...BUILT_IN_MODES },
	handoff: {
		defaultMode: "default",
	},
	sessions: {
		autoIndex: true,
		maxIndexEntries: 500,
	},
	web: {
		searchTimeout: 120000,
		fetchTimeout: 30000,
	},
};
