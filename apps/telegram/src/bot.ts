import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
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
	for (const chunk of splitMessage(text)) {
		try {
			await ctx.api.sendMessage(ctx.chat.id, convertMarkdownToTelegramHtml(chunk), { parse_mode: "HTML" });
		} catch (error: unknown) {
			if (error instanceof GrammyError) {
				await ctx.api.sendMessage(ctx.chat.id, chunk);
			} else {
				throw error;
			}
		}
	}
}

async function downloadTelegramFile(ctx: Context, config: TelegramAppConfig, fileId: string, preferredName: string) {
	const file = await ctx.api.getFile(fileId);
	if (!file.file_path) throw new Error("Telegram file path unavailable");
	const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	const attachmentDir = resolve(config.storageDir, "attachments", String(ctx.chat?.id ?? "unknown"));
	await mkdir(attachmentDir, { recursive: true });
	const safeName = preferredName.replace(/[^a-zA-Z0-9._-]+/g, "-");
	const path = resolve(attachmentDir, safeName);
	await writeFile(path, buffer);
	return path;
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

	const handleIncomingMessage = async (ctx: Context, text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (isTelegramLocalCommand(trimmed)) return;

		const chatId = String(ctx.chat!.id);
		const { ref } = getActiveModel();

		await ctx.api.sendChatAction(ctx.chat!.id, "typing");
		await resolveAssistantThread(config, chatId, ref);
		const response = await sendAssistantMessage(config, chatId, trimmed, ref);
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
		await sendHtml(ctx, response.text || "(empty response)");
	};

	bot.on("message:text", async (ctx) => {
		try {
			await handleIncomingMessage(ctx, ctx.message.text);
		} catch (error: unknown) {
			console.error("Failed to process Telegram message", error);
			await ctx.api.sendMessage(ctx.chat.id, escapeHtml("Sorry — I hit an error."), { parse_mode: "HTML" });
		}
	});

	bot.on("message:document", async (ctx) => {
		try {
			const doc = ctx.message.document;
			const ext = extname(doc.file_name || "") || ".bin";
			const fileName = doc.file_name || `${doc.file_unique_id}${ext}`;
			const savedPath = await downloadTelegramFile(ctx, config, doc.file_id, fileName);
			const caption = ctx.message.caption?.trim();
			const prompt = [
				caption ? `User caption: ${caption}` : undefined,
				`A Telegram file was attached and saved locally at: ${savedPath}`,
				`Original filename: ${fileName}`,
				"Use read if you need to inspect it.",
			].filter(Boolean).join("\n\n");
			await handleIncomingMessage(ctx, prompt);
		} catch (error: unknown) {
			console.error("Failed to process Telegram document", error);
			await ctx.api.sendMessage(ctx.chat.id, escapeHtml("Sorry — I hit an error while handling that file."), { parse_mode: "HTML" });
		}
	});

	bot.on("message:photo", async (ctx) => {
		try {
			const photo = ctx.message.photo.at(-1);
			if (!photo) return;
			const savedPath = await downloadTelegramFile(ctx, config, photo.file_id, `${photo.file_unique_id}.jpg`);
			const caption = ctx.message.caption?.trim();
			const prompt = [
				caption ? `User caption: ${caption}` : undefined,
				`A Telegram image was attached and saved locally at: ${savedPath}`,
				"Use read if you need to inspect it.",
			].filter(Boolean).join("\n\n");
			await handleIncomingMessage(ctx, prompt);
		} catch (error: unknown) {
			console.error("Failed to process Telegram photo", error);
			await ctx.api.sendMessage(ctx.chat.id, escapeHtml("Sorry — I hit an error while handling that image."), { parse_mode: "HTML" });
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
