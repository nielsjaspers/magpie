import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getActiveConfigScope,
	getConfigBaseDir,
	getMode,
	loadAuthConfig,
	loadConfig,
	resolvePromptText,
} from "../config/config.js";
import type { MagpieAuthConfig, MagpieConfig } from "../config/types.js";
import { getActiveModeName } from "../pa/shared/mode.js";
import type { ScheduleNotifier, ScheduleRuntimeOptions, ScheduleStore, ScheduleTaskInput } from "./types.js";

export const SCHEDULE_BACKGROUND_PROMPT = [
	"You are running as a scheduled background Magpie task.",
	"Actually perform the requested work in the working directory using tools when needed.",
	"Do not merely describe what you would do if a file edit, shell command, or write is required.",
	"Be concise in final output, but make the real changes.",
].join(" ");

export function createScheduleId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getMagpiePackageDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function getMagpieExtensionPaths(): Promise<string[]> {
	const packageDir = getMagpiePackageDir();
	const requiredExtensions = new Set([
		"subagents/index.ts",
		"modes/index.ts",
		"sessions/index.ts",
		"preferences/index.ts",
		"memory/index.ts",
	]);
	try {
		const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		const extensions = packageJson.pi?.extensions ?? [];
		return extensions
			.filter((value) => typeof value === "string" && requiredExtensions.has(value))
			.map((value) => resolve(packageDir, value));
	} catch {
		return Array.from(requiredExtensions).map((value) => resolve(packageDir, value));
	}
}

export function resolveScheduleNotifier(config: MagpieConfig, auth: MagpieAuthConfig, shouldNotify: boolean, preferred?: "telegram" | "macos" | "none"): ScheduleNotifier {
	if (!shouldNotify) return { kind: "none" };
	const explicit = preferred ?? config.schedule?.notifier;
	const telegramConfigured = Boolean(config.schedule?.telegram?.chatId?.trim() && (config.schedule?.telegram?.botToken?.trim() || auth.telegram?.botToken?.trim()));
	const kind = explicit ?? (process.platform === "darwin" ? "macos" : telegramConfigured ? "telegram" : "none");
	if (kind === "none") return { kind: "none" };
	if (kind === "macos") return { kind: "macos" };
	const botToken = config.schedule?.telegram?.botToken?.trim() || auth.telegram?.botToken?.trim();
	const chatId = config.schedule?.telegram?.chatId?.trim();
	if (!botToken || !chatId) throw new Error("schedule notifier is set to telegram, but schedule.telegram.chatId and a Telegram bot token are not fully configured.");
	return { kind: "telegram", botToken, chatId };
}

export async function resolveScheduleRuntimeOptions(
	ctx: ExtensionContext,
	store: ScheduleStore,
	id: string,
	input: ScheduleTaskInput,
) {
	const cwd = resolve(input.cwd?.trim() || ctx.cwd);
	const [config, auth] = await Promise.all([loadConfig(cwd), loadAuthConfig(cwd)]);
	const modeName = input.mode?.trim() || getActiveModeName(ctx, config);
	const mode = getMode(config, modeName) ?? getMode(config, "smart");
	const baseDir = getConfigBaseDir(getActiveConfigScope(cwd), cwd);
	const modePromptText = mode?.prompt ? await resolvePromptText(baseDir, mode.prompt) : undefined;
	const promptParts = [modePromptText?.trim(), SCHEDULE_BACKGROUND_PROMPT].filter(Boolean) as string[];
	return {
		cwd,
		mode: mode?.name ?? modeName,
		model: input.model ?? mode?.model,
		thinkingLevel: mode?.thinkingLevel,
		systemPrompt: promptParts.length === 0 ? undefined : {
			strategy: mode?.prompt?.strategy ?? "append",
			text: promptParts.join("\n\n"),
		},
		notifier: resolveScheduleNotifier(config, auth, input.notify !== false, input.preferredNotifier),
		sessionRootDir: resolve(store.baseDir, "sessions", id),
		extensionMode: input.extensionMode ?? "builtin",
	} satisfies ScheduleRuntimeOptions & { cwd: string };
}

export function formatNotificationSummary(notifier: ScheduleNotifier, enabled: boolean) {
	if (!enabled || notifier.kind === "none") return "Notification disabled.";
	if (notifier.kind === "macos") return "Notification will be sent via macOS when complete.";
	return "Notification will be sent via Telegram when complete.";
}
