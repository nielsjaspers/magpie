import type { Bot } from "grammy";
import type { TelegramAppConfig } from "./config.js";
import { getAssistantThreadSnapshot, getAssistantThreadStatus, resetAssistantThread } from "./host-client.js";
import { getActiveModel, setActiveModel } from "./session.js";

const HELP_TEXT = `Available commands:

/model           Show current model
/model <alias>   Switch model
/session         Show current session status
/peek            Show a lightweight recent session snapshot
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

	bot.command("session", async (ctx) => {
		const chatId = String(ctx.chat.id);
		const { ref } = getActiveModel();
		const status = await getAssistantThreadStatus(config, chatId, ref);
		await ctx.reply([
			`Thread: ${status.threadKey}`,
			`Exists: ${status.exists ? "yes" : "no"}`,
			`Loaded: ${status.loaded ? "yes" : "no"}`,
			status.sessionId ? `Session ID: ${status.sessionId}` : undefined,
			status.sessionPath ? `Session file: ${status.sessionPath}` : undefined,
			status.updatedAt ? `Updated: ${status.updatedAt}` : undefined,
			status.messageCount !== undefined ? `Messages: ${status.messageCount}` : undefined,
		].filter(Boolean).join("\n"));
	});

	bot.command("peek", async (ctx) => {
		const chatId = String(ctx.chat.id);
		const { ref } = getActiveModel();
		const snapshot = await getAssistantThreadSnapshot(config, chatId, ref, 8);
		if (!snapshot.exists || !snapshot.messages || snapshot.messages.length === 0) {
			await ctx.reply("No stored messages for this chat yet.");
			return;
		}
		const lines = snapshot.messages.map((message, index) => {
			const text = (message.text || "").replace(/\s+/g, " ").trim();
			const preview = text.length > 180 ? `${text.slice(0, 180)}…` : text;
			return `${index + 1}. ${message.role}: ${preview || "(no text)"}`;
		});
		await ctx.reply(lines.join("\n\n"));
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
