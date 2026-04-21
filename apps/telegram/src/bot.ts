import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { isTelegramLocalCommand, registerCommands } from "./commands.js";
import { resolveAssistantThread, sendAssistantMessage } from "./host-client.js";
import { getActiveModel } from "./session.js";
import { convertMarkdownToTelegramHtml, escapeHtml, splitMessage } from "./utils.js";
import type { TelegramAppConfig } from "./config.js";

export function senderId(from: { id: number; username?: string | undefined }): string {
	return from.username ? `${from.id}|${from.username}` : String(from.id);
}

export function isAllowed(sender: string, allowList: Set<string>): boolean {
	if (allowList.size === 0) return true;
	if (allowList.has("*")) return true;
	if (allowList.has(sender)) return true;
	if (sender.includes("|")) {
		const [id, username] = sender.split("|", 2);
		return allowList.has(id) || allowList.has(username);
	}
	return false;
}

async function sendHtml(ctx: Context, text: string) {
	if (!ctx.chat) return;
	try {
		await ctx.api.sendMessage(ctx.chat.id, convertMarkdownToTelegramHtml(text), { parse_mode: "HTML" });
	} catch (error: unknown) {
		if (error instanceof GrammyError) {
			await ctx.api.sendMessage(ctx.chat.id, text);
		} else {
			throw error;
		}
	}
}

export function createBot(config: TelegramAppConfig): Bot {
	if (!config.botToken) {
		throw new Error("Missing telegram.botToken in magpie.auth.json");
	}

	const allowList = new Set(config.allowFrom);
	const bot = new Bot(config.botToken);

	bot.use(async (ctx, next) => {
		if (!ctx.from) return;
		if (!isAllowed(senderId(ctx.from), allowList)) return;
		await next();
	});

	registerCommands(bot, config);

	bot.on("message:text", async (ctx) => {
		const text = ctx.message.text.trim();
		if (!text) return;
		if (isTelegramLocalCommand(text)) return;

		const chatId = String(ctx.chat.id);
		const { ref } = getActiveModel();

		try {
			await ctx.api.sendChatAction(ctx.chat.id, "typing");
			await resolveAssistantThread(config, chatId, ref);
			const response = await sendAssistantMessage(config, chatId, text, ref);
			if (config.showToolCalls && response.toolEvents?.length) {
				for (const event of response.toolEvents) {
					if (event.type === "start") {
						const argsPreview = event.args ? JSON.stringify(event.args, null, 2) : "";
						const toolText = `[Tool: ${event.toolName}] executing…${argsPreview ? "\n" + argsPreview : ""}`;
						await sendHtml(ctx, toolText);
					} else {
						const prefix = event.isError ? `[Tool: ${event.toolName}] error` : `[Tool: ${event.toolName}] done`;
						let resultPreview = event.result || "";
						if (resultPreview.length > 1000) resultPreview = resultPreview.slice(0, 1000) + "\n… (truncated)";
						await sendHtml(ctx, resultPreview ? `${prefix}\n${resultPreview}` : prefix);
					}
				}
			}
			for (const chunk of splitMessage(response.text || "(empty response)")) {
				await sendHtml(ctx, chunk);
			}
		} catch (error: unknown) {
			console.error("Failed to process Telegram message", error);
			await ctx.api.sendMessage(ctx.chat.id, escapeHtml("Sorry — I hit an error."), { parse_mode: "HTML" });
		}
	});

	bot.catch((error) => {
		const { ctx } = error;
		console.error(`Telegram update ${ctx.update.update_id} failed`);

		if (error.error instanceof GrammyError) {
			console.error("Telegram API error:", error.error.description);
		} else if (error.error instanceof HttpError) {
			console.error("Telegram network error:", error.error);
		} else {
			console.error("Unknown Telegram error:", error.error);
		}
	});

	return bot;
}
