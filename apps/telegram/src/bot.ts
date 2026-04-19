import { Bot, GrammyError, HttpError } from "grammy";
import { registerCommands } from "./commands.js";
import { resolveAssistantThread, sendAssistantMessage } from "./host-client.js";
import { getActiveModel } from "./session.js";
import { splitMessage } from "./utils.js";
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
		if (!text || text.startsWith("/")) return;

		const chatId = String(ctx.chat.id);
		const { ref } = getActiveModel();

		try {
			await ctx.api.sendChatAction(ctx.chat.id, "typing");
			await resolveAssistantThread(config, chatId, ref);
			const response = await sendAssistantMessage(config, chatId, text, ref);
			for (const chunk of splitMessage(response.text || "(empty response)")) {
				await ctx.api.sendMessage(ctx.chat.id, chunk);
			}
		} catch (error: unknown) {
			console.error("Failed to process Telegram message", error);
			await ctx.api.sendMessage(ctx.chat.id, "Sorry — I hit an error.");
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
