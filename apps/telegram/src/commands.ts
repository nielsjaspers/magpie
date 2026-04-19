import type { Bot } from "grammy";
import type { TelegramAppConfig } from "./config.js";
import { resetAssistantThread } from "./host-client.js";
import { getActiveModel, setActiveModel } from "./session.js";

const HELP_TEXT = `Available commands:

/model           Show current model
/model <alias>   Switch model
/restart         Clear session and start fresh
/new             Clear session (will support session reattachment later)
/clear           Clear session
/help            Show this help message

Just type anything else to chat.`;

export function registerCommands(bot: Bot, config: TelegramAppConfig): void {
	bot.command("help", async (ctx) => {
		await ctx.reply(HELP_TEXT);
	});

	bot.command("model", async (ctx) => {
		const arg = ctx.message?.text.split(/\s+/)[1]?.trim();

		if (!arg) {
			const { alias, ref } = getActiveModel();
			const lines = [`Current model: ${alias} (${ref})`, "", "Available models:"];
			for (const [a, r] of Object.entries(config.models)) {
				const marker = a === alias ? " [active]" : "";
				lines.push(`  ${a} = ${r}${marker}`);
			}
			await ctx.reply(lines.join("\n"));
			return;
		}

		const ref = config.models[arg];
		if (!ref) {
			const available = Object.keys(config.models).join(", ") || "(none configured)";
			await ctx.reply(`Unknown model "${arg}". Available: ${available}`);
			return;
		}

		setActiveModel(arg, ref);
		await ctx.reply(`Switched to ${arg} (${ref}).`);
	});

	bot.command("restart", async (ctx) => {
		const chatId = String(ctx.chat.id);
		await resetAssistantThread(config, chatId);
		await ctx.reply("Session cleared. Starting fresh on your next message.");
	});

	bot.command("new", async (ctx) => {
		const chatId = String(ctx.chat.id);
		await resetAssistantThread(config, chatId);
		await ctx.reply("Session cleared. Starting fresh on your next message.");
	});

	bot.command("clear", async (ctx) => {
		const chatId = String(ctx.chat.id);
		await resetAssistantThread(config, chatId);
		await ctx.reply("Session cleared.");
	});
}
