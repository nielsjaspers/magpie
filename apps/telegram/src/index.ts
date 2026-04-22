import { loadTelegramConfig, validateAndExit } from "./config.js";
import { createBot } from "./bot.js";
import { setActiveModel } from "./session.js";

const config = await loadTelegramConfig(process.cwd());
validateAndExit(config);

const firstAlias = Object.keys(config.models)[0];
if (firstAlias) {
	setActiveModel(firstAlias, config.models[firstAlias]);
}

const bot = createBot(config);

function shutdown() {
	console.log("\nShutting down...");
	bot.stop();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Starting Magpie-backed Telegram bot...");
await bot.start();
