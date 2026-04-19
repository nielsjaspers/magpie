import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	getGlobalAuthPath,
	getGlobalConfigPath,
	getProjectAuthPath,
	getProjectConfigPath,
	loadAuthConfig,
	loadConfig,
	getTelegramAuth,
	getTelegramConfig,
} from "../../../config/config.js";

export interface TelegramAppConfig {
	botToken: string;
	allowFrom: string[];
	models: Record<string, string>;
	showToolCalls: boolean;
	prompt: {
		systemFile?: string;
		memoryFile?: string;
		userFile?: string;
		customFiles: string[];
	};
	configScope: "global" | "project";
	globalConfigPath: string;
	projectConfigPath: string;
	globalAuthPath: string;
	projectAuthPath: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful general-purpose assistant.
Be concise, clear, and direct. Answer questions accurately.
You are accessed through a Telegram bot — keep responses brief and well-formatted.`;

export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash < 0 || slash === 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

async function tryReadText(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

function pickConfigScope(cwd: string): "global" | "project" {
	return existsSync(getProjectConfigPath(cwd)) ? "project" : "global";
}

function validateConfig(config: TelegramAppConfig): string[] {
	const errors: string[] = [];
	if (!config.botToken) {
		errors.push("telegram.botToken is not set in magpie.auth.json");
	}
	if (Object.keys(config.models).length === 0) {
		errors.push("telegram.models is empty in magpie.json — add at least one model alias");
	}
	return errors;
}

export async function loadTelegramConfig(cwd: string): Promise<TelegramAppConfig> {
	const config = await loadConfig(cwd);
	const auth = await loadAuthConfig(cwd);
	const telegram = getTelegramConfig(config);
	const telegramAuth = getTelegramAuth(auth);
	const configScope = pickConfigScope(cwd);

	return {
		botToken: telegramAuth?.botToken?.trim() || "",
		allowFrom: telegram?.allowFrom ?? [],
		models: telegram?.models ?? {},
		showToolCalls: telegram?.showToolCalls ?? false,
		prompt: {
			systemFile: telegram?.prompt?.systemFile,
			memoryFile: telegram?.prompt?.memoryFile,
			userFile: telegram?.prompt?.userFile,
			customFiles: telegram?.prompt?.customFiles ?? [],
		},
		configScope,
		globalConfigPath: getGlobalConfigPath(),
		projectConfigPath: getProjectConfigPath(cwd),
		globalAuthPath: getGlobalAuthPath(),
		projectAuthPath: getProjectAuthPath(cwd),
	};
}

export function validateAndExit(config: TelegramAppConfig): void {
	const errors = validateConfig(config);
	if (errors.length === 0) return;

	console.error("\nConfig error:\n");
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	console.error("\nEdit one of:\n");
	console.error(`  config: ${config.projectConfigPath}`);
	console.error(`  config: ${config.globalConfigPath}`);
	console.error(`  auth:   ${config.projectAuthPath}`);
	console.error(`  auth:   ${config.globalAuthPath}`);
	console.error("");
	process.exit(1);
}

export async function buildSystemPrompt(config: TelegramAppConfig): Promise<string> {
	const projectBaseDir = dirname(config.projectConfigPath);
	const globalBaseDir = dirname(config.globalConfigPath);
	const parts: string[] = [];

	const readScoped = async (relativePath: string | undefined) => {
		if (!relativePath?.trim()) return undefined;
		return (await tryReadText(resolve(projectBaseDir, relativePath))) ??
			(await tryReadText(resolve(globalBaseDir, relativePath)));
	};

	const systemContent = await readScoped(config.prompt.systemFile);
	if (systemContent?.trim()) parts.push(systemContent.trim());

	const memoryContent = await readScoped(config.prompt.memoryFile);
	if (memoryContent?.trim()) parts.push(`## Memory\n${memoryContent.trim()}`);

	const userContent = await readScoped(config.prompt.userFile);
	if (userContent?.trim()) parts.push(`## User Context\n${userContent.trim()}`);

	for (const path of config.prompt.customFiles) {
		const content = await readScoped(path);
		if (content?.trim()) parts.push(content.trim());
	}

	return parts.length > 0 ? parts.join("\n\n") : DEFAULT_SYSTEM_PROMPT;
}
