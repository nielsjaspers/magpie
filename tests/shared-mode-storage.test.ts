import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { getActiveModeConfig, getActiveModeName, isAnyToolDisabledInActiveMode, isToolDisabledInActiveMode, isToolDisabledInMode, normalizeMagpieModeName, MODE_STATE_TYPE } from "../pa/shared/mode.js";
import { ensureDir, getPaCalendarCacheDir, getPaCalendarDir, getPaCalendarLogsDir, getPaMailContactDir, getPaMailContactDraftsDir, getPaMailContactsDir, getPaMailDir, getPaMailHistoryDir } from "../pa/shared/storage.js";
import { resolveSubagentHeaders } from "../subagents/headers.js";

function context(activeMode?: string) {
	return {
		sessionManager: {
			getEntries: () => activeMode ? [{ type: "custom", customType: MODE_STATE_TYPE, data: { activeMode } }] : [],
		},
	} as any;
}

describe("shared mode, storage, and subagent headers", () => {
	test("normalizes and resolves active modes and disabled tools", () => {
		const config = {
			...DEFAULT_CONFIG,
			startupMode: "smart",
			modes: {
				...DEFAULT_CONFIG.modes,
				quiet: { disableTools: ["web_search"] },
			},
		};

		expect(normalizeMagpieModeName(" default ")).toBe("smart");
		expect(getActiveModeName(context("quiet"), config)).toBe("quiet");
		expect(getActiveModeConfig(context("quiet"), config)).toMatchObject({ name: "quiet" });
		expect(isToolDisabledInMode(config, "quiet", "web_search")).toBe(true);
		expect(isToolDisabledInActiveMode(context("quiet"), config, "web_search")).toBe(true);
		expect(isAnyToolDisabledInActiveMode(context("quiet"), config, ["read", "web_search"])).toBe(true);
	});

	test("builds PA storage paths and creates directories", async () => {
		const root = await mkdtemp(resolve("/tmp", "magpie-pa-"));

		expect(getPaCalendarDir(root)).toBe(resolve(root, "calendar"));
		expect(getPaCalendarCacheDir(root)).toBe(resolve(root, "calendar/cache"));
		expect(getPaCalendarLogsDir(root)).toBe(resolve(root, "calendar/logs"));
		expect(getPaMailDir(root)).toBe(resolve(root, "mail"));
		expect(getPaMailContactsDir(root)).toBe(resolve(root, "mail/contacts"));
		expect(getPaMailContactDir(root, "ada")).toBe(resolve(root, "mail/contacts/ada"));
		expect(getPaMailContactDraftsDir(root, "ada")).toBe(resolve(root, "mail/contacts/ada/drafts"));
		expect(getPaMailHistoryDir(root)).toBe(resolve(root, "mail/history"));
		expect(await ensureDir(resolve(root, "new/dir"))).toBe(resolve(root, "new/dir"));
	});

	test("adds Copilot subagent headers only for subagents", () => {
		expect(resolveSubagentHeaders({ Existing: "1" }, { provider: "github-copilot" }, true)).toMatchObject({
			Existing: "1",
			"X-Initiator": "agent",
			"x-initiator": "agent",
			"Openai-Intent": "conversation-edits",
		});
		expect(resolveSubagentHeaders(undefined, { provider: "github-copilot" }, false)).toEqual({});
		expect(resolveSubagentHeaders({ Existing: "1" }, { provider: "opencode" }, true)).toEqual({ Existing: "1" });
	});
});
