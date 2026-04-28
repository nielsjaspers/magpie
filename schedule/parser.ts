import * as chrono from "chrono-node";
import type { ParsedScheduleRequest } from "./types.js";

function isCronExpression(value: string) {
	const parts = value.trim().split(/\s+/);
	return parts.length === 5 && parts.every(Boolean);
}

function parseTimeOfDay(input: string | undefined) {
	if (!input?.trim()) return { hour: 9, minute: 0 };
	const parsed = chrono.parseDate(input, new Date(), { forwardDate: true });
	if (!parsed) return undefined;
	return { hour: parsed.getHours(), minute: parsed.getMinutes() };
}

function parseRecurringNaturalWhen(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();

	if (/^(every\s+hour|hourly)$/.test(lower)) return "0 * * * *";
	let match = lower.match(/^every\s+(\d+)\s+minutes?$/);
	if (match) {
		const step = Number(match[1]);
		if (step >= 1 && step <= 59) return `*/${step} * * * *`;
	}
	match = lower.match(/^every\s+(\d+)\s+hours?$/);
	if (match) {
		const step = Number(match[1]);
		if (step >= 1 && step <= 23) return `0 */${step} * * *`;
	}

	match = lower.match(/^(?:every|each)\s+day(?:\s+at\s+(.+))?$/) || lower.match(/^daily(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[1]);
		if (tod) return `${tod.minute} ${tod.hour} * * *`;
	}

	match = lower.match(/^(?:every|each)\s+weekdays?(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[1]);
		if (tod) return `${tod.minute} ${tod.hour} * * 1-5`;
	}

	const dayMap: Record<string, number> = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	};
	match = lower.match(/^(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(.+))?$/);
	if (match) {
		const tod = parseTimeOfDay(match[2]);
		if (tod) return `${tod.minute} ${tod.hour} * * ${dayMap[match[1]]}`;
	}

	match = lower.match(/^every\s+week(?:\s+on\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))?(?:\s+at\s+(.+))?$/);
	if (match) {
		const day = match[1] || "monday";
		const tod = parseTimeOfDay(match[2]);
		if (tod) return `${tod.minute} ${tod.hour} * * ${dayMap[day]}`;
	}

	return undefined;
}

export function parseWhenSpec(input: string): ParsedScheduleRequest | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("cron:")) {
		const cronExpr = trimmed.slice(5).trim();
		if (!isCronExpression(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`);
		return { type: "recurring", when: trimmed, cronExpr };
	}
	const recurringCron = parseRecurringNaturalWhen(trimmed);
	if (recurringCron) return { type: "recurring", when: trimmed, cronExpr: recurringCron };
	const relative = trimmed.match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const now = Date.now();
		const delta = unit.startsWith("minute") ? amount * 60_000 : unit.startsWith("hour") ? amount * 3_600_000 : amount * 86_400_000;
		return { type: "one-shot", when: trimmed, runAt: new Date(now + delta).toISOString() };
	}
	const parsed = chrono.parseDate(trimmed, new Date(), { forwardDate: true });
	if (parsed && Number.isFinite(parsed.getTime())) return { type: "one-shot", when: trimmed, runAt: parsed.toISOString() };
	const legacy = new Date(trimmed);
	if (Number.isFinite(legacy.getTime())) return { type: "one-shot", when: trimmed, runAt: legacy.toISOString() };
	return undefined;
}
