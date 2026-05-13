import ical from "node-ical";
import type { VEvent } from "node-ical";
import type { PaCalendarEvent } from "../shared/types.js";

export type IcsFeedConfig = {
	id?: string;
	name?: string;
	url?: string;
};

export function normalizeFeedUrl(url: string): string {
	return url.startsWith("webcal://") ? `https://${url.slice("webcal://".length)}` : url;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "feed";
}

export function getFeedId(feed: IcsFeedConfig, index: number): string {
	return feed.id?.trim() || slugify(feed.name?.trim() || `ics-${index + 1}`);
}

export function getFeedName(feed: IcsFeedConfig, index: number): string {
	return feed.name?.trim() || `ICS Feed ${index + 1}`;
}

function asDate(value: unknown): Date | null {
	if (!value) return null;
	if (value instanceof Date) return value;
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}
	if (typeof value === "object" && value && "toJSDate" in value && typeof (value as any).toJSDate === "function") {
		const parsed = (value as any).toJSDate();
		return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
	}
	return null;
}

function eventDescription(value: unknown): string | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "object" && value && "val" in value) return String((value as any).val ?? "") || undefined;
	return String(value);
}

function normalizeSummary(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value && "val" in value) return String((value as any).val ?? "Untitled");
	return value ? String(value) : "Untitled";
}

export function truncate(text: string | undefined, length: number): string | undefined {
	if (!text) return undefined;
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function windowFilter(events: PaCalendarEvent[], days: number, calendarIds?: string[], query?: string): PaCalendarEvent[] {
	const start = new Date();
	const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	const queryText = query?.trim().toLowerCase();
	const allowedIds = calendarIds?.length ? new Set(calendarIds) : null;
	return events.filter((event) => {
		if (allowedIds && !allowedIds.has(event.calendarId)) return false;
		if (queryText && !event.summary.toLowerCase().includes(queryText)) return false;
		const eventStart = new Date(event.start);
		const eventEnd = new Date(event.end);
		return eventEnd >= start && eventStart <= end;
	});
}

export function buildIcsEvents(parsed: Record<string, any>, calendarId: string): PaCalendarEvent[] {
	const out: PaCalendarEvent[] = [];
	for (const entry of Object.values(parsed)) {
		if (!entry || entry.type !== "VEVENT") continue;
		const event = entry as VEvent;
		if (event.rrule) {
			const instances = ical.expandRecurringEvent(event, {
				from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
				to: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
				includeOverrides: true,
				excludeExdates: true,
				expandOngoing: true,
			});
			for (const instance of instances) {
				const start = asDate(instance.start);
				const end = asDate(instance.end);
				if (!start || !end) continue;
				out.push({
					id: `${event.uid}:${start.toISOString()}`,
					calendarId,
					summary: normalizeSummary(instance.summary),
					start: start.toISOString(),
					end: end.toISOString(),
					allDay: instance.isFullDay,
					location: eventDescription(event.location),
					description: eventDescription(event.description),
					sourceType: "ics",
				});
			}
			continue;
		}
		const start = asDate(event.start);
		const end = asDate(event.end ?? event.start);
		if (!start || !end) continue;
		out.push({
			id: event.uid,
			calendarId,
			summary: normalizeSummary(event.summary),
			start: start.toISOString(),
			end: end.toISOString(),
			allDay: event.datetype === "date",
			location: eventDescription(event.location),
			description: eventDescription(event.description),
			sourceType: "ics",
		});
	}
	return out.sort((a, b) => a.start.localeCompare(b.start));
}
