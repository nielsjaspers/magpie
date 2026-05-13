/**
 * Spinner Extension
 *
 * Replaces the default "Working..." message with random verbs
 * that rotate every 6-10 seconds during streaming.
 *
 * Usage:
 *   pi --extension spinner/spinner.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SPINNER_VERBS } from "./verbs.js";

export function randomVerb(): string {
	if (Math.random() < 0.001) {
		return 'Help! I\'m stuck in the computer';
	}
	return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

export function randomDelay(): number {
	return 6000 + Math.random() * 4000; // 6-10 seconds
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function scheduleRotation(ctx: ExtensionContext) {
		clearTimer();
		ctx.ui.setWorkingMessage(`${randomVerb()}...`);
		timer = setTimeout(() => {
			scheduleRotation(ctx);
		}, randomDelay());
	}

	pi.on("agent_start", async (_event, ctx) => {
		scheduleRotation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearTimer();
		// Reset to default
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		clearTimer();
	});
}
