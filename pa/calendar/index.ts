import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ical from "node-ical";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPersonalAssistantRuntime } from "../shared/config.js";
import { ensureDir, getPaCalendarCacheDir } from "../shared/storage.js";
import type { PaCalendarEvent, PaCalendarSource } from "../shared/types.js";
import { buildIcsEvents, getFeedId, getFeedName, normalizeFeedUrl, truncate, windowFilter, type IcsFeedConfig } from "./ics.js";
import {
	clearICloudClient,
	createICloudEventIcs,
	fetchICloudEvents,
	getICloudClient,
	listICloudCalendars,
	selectWritableCalendar,
} from "./icloud.js";

type CachedFeed = {
	fetchedAt: number;
	events: PaCalendarEvent[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map<string, CachedFeed>();

async function fetchIcsFeed(feed: IcsFeedConfig, index: number, storageDir: string, signal?: AbortSignal) {
	const id = getFeedId(feed, index);
	const cached = memoryCache.get(id);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.events;
	const url = feed.url?.trim();
	if (!url) throw new Error(`ICS feed ${id} is missing url`);
	const normalizedUrl = normalizeFeedUrl(url);
	const response = await fetch(normalizedUrl, { signal, headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" } });
	if (!response.ok) throw new Error(`ICS feed ${id} failed with HTTP ${response.status}`);
	const body = await response.text();
	const parsed = ical.parseICS(body);
	const events = buildIcsEvents(parsed, id);
	memoryCache.set(id, { fetchedAt: Date.now(), events });
	const cacheDir = await ensureDir(getPaCalendarCacheDir(storageDir));
	await writeFile(resolve(cacheDir, `${id}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), sourceUrl: normalizedUrl, events }, null, 2), "utf8");
	return events;
}

async function loadCachedFeed(id: string, storageDir: string): Promise<PaCalendarEvent[] | null> {
	try {
		const cachePath = resolve(getPaCalendarCacheDir(storageDir), `${id}.json`);
		const parsed = JSON.parse(await readFile(cachePath, "utf8")) as { events?: PaCalendarEvent[] };
		return parsed.events ?? null;
	} catch {
		return null;
	}
}

export async function createCalendarEventForContext(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	params: { summary: string; start: string; end: string; location?: string; description?: string; allDay?: boolean; calendarId?: string },
): Promise<{ event: PaCalendarEvent; targetCalendar: { id: string; name: string } }> {
	const runtime = await loadPersonalAssistantRuntime(ctx);
	const icloud = runtime.personalAssistantAuth?.calendar?.icloud;
	if (!icloud?.email || !icloud.appPassword) {
		throw new Error("iCloud calendar writing is not configured. Add personalAssistant.calendar.icloud credentials to magpie.auth.json.");
	}
	const calendars = await listICloudCalendars(icloud.email, icloud.appPassword);
	const defaultCalendar = runtime.personalAssistant?.calendar?.defaultWritableCalendar;
	const targetCalendar = selectWritableCalendar(calendars, defaultCalendar, params.calendarId);
	if (!targetCalendar) {
		throw new Error(`No writable iCloud calendar matched the requested/default target. Available iCloud calendars: ${calendars.map((calendar) => calendar.name).join(", ") || "none"}`);
	}
	const start = new Date(params.start);
	const end = new Date(params.end);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
		throw new Error("Invalid start/end timestamps. Use ISO 8601 and ensure end is after start.");
	}
	const { uid, iCalString } = createICloudEventIcs({ start, end, summary: params.summary, location: params.location, description: params.description, allDay: params.allDay });
	const client = await getICloudClient(icloud.email, icloud.appPassword);
	await client.createCalendarObject({
		calendar: targetCalendar.calendar,
		iCalString,
		filename: `${uid}.ics`,
	});
	return {
		event: {
			id: uid,
			calendarId: targetCalendar.id,
			summary: params.summary,
			start: start.toISOString(),
			end: end.toISOString(),
			allDay: params.allDay ?? false,
			location: params.location,
			description: params.description,
			sourceType: "icloud",
		},
		targetCalendar: { id: targetCalendar.id, name: targetCalendar.name },
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "calendar_list_calendars",
		label: "Calendar List Calendars",
		description: "List personal-assistant calendar sources.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const feeds = runtime.personalAssistantAuth?.calendar?.icsFeeds ?? [];
			const calendars: PaCalendarSource[] = feeds.map((feed, index) => ({
				id: getFeedId(feed, index),
				name: getFeedName(feed, index),
				sourceType: "ics",
				writable: false,
				readOnly: true,
			}));
			const icloud = runtime.personalAssistantAuth?.calendar?.icloud;
			const warnings: string[] = [];
			if (icloud?.email && icloud.appPassword) {
				try {
					const icloudCalendars = await listICloudCalendars(icloud.email, icloud.appPassword);
					calendars.push(...icloudCalendars.map(({ calendar: _calendar, ...rest }) => rest));
				} catch (error) {
					clearICloudClient(icloud.email, icloud.appPassword);
					warnings.push(`iCloud authentication failed: ${(error as Error).message}`);
				}
			}
			const lines = calendars.length > 0
				? calendars.map((calendar) => `- id=${calendar.id} | ${calendar.name} | ${calendar.sourceType} | ${calendar.writable ? "writable" : "read-only"}`)
				: ["No calendar sources configured."];
			return {
				content: [{ type: "text", text: `${lines.join("\n")}${warnings.length ? `\n\nWarnings:\n- ${warnings.join("\n- ")}` : ""}` }],
				details: { calendars, warnings },
			};
		},
	});

	pi.registerTool({
		name: "calendar_upcoming",
		label: "Calendar Upcoming",
		description: "Get upcoming calendar events from PA-configured sources.",
		parameters: Type.Object({
			days: Type.Optional(Type.Number({ minimum: 1, maximum: 60, default: 7 })),
			calendarIds: Type.Optional(Type.Array(Type.String())),
			query: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const days = Math.max(1, Math.floor(params.days ?? 7));
			const feeds = runtime.personalAssistantAuth?.calendar?.icsFeeds ?? [];
			const events: PaCalendarEvent[] = [];
			const warnings: string[] = [];
			for (const [index, feed] of feeds.entries()) {
				const id = getFeedId(feed, index);
				try {
					events.push(...await fetchIcsFeed(feed, index, runtime.storageDir, signal));
				} catch (error) {
					const cached = await loadCachedFeed(id, runtime.storageDir);
					if (cached) {
						events.push(...cached);
						warnings.push(`Using cached data for ${id}: ${(error as Error).message}`);
					} else {
						warnings.push(`Failed to load ${id}: ${(error as Error).message}`);
					}
				}
			}
			const icloud = runtime.personalAssistantAuth?.calendar?.icloud;
			if (icloud?.email && icloud.appPassword) {
				try {
					const client = await getICloudClient(icloud.email, icloud.appPassword);
					const calendars = await listICloudCalendars(icloud.email, icloud.appPassword);
					for (const calendar of calendars) events.push(...await fetchICloudEvents(client, calendar, days));
				} catch (error) {
					clearICloudClient(icloud.email, icloud.appPassword);
					warnings.push(`iCloud authentication failed: ${(error as Error).message}`);
				}
			}
			const filtered = windowFilter(events, days, params.calendarIds, params.query).sort((a, b) => a.start.localeCompare(b.start));
			const summary = filtered.length > 0
				? filtered.slice(0, 12).map((event) => `- id=${event.id} | calendar=${event.calendarId} | ${event.start} | ${event.summary}`).join("\n")
				: "No matching upcoming events.";
			return {
				content: [{ type: "text", text: warnings.length > 0 ? `${summary}\n\nWarnings:\n- ${warnings.join("\n- ")}` : summary }],
				details: { events: filtered.map((event) => ({ ...event, description: truncate(event.description, 500) })), warnings },
			};
		},
	});

	pi.registerTool({
		name: "calendar_get_event",
		label: "Calendar Get Event",
		description: "Get a full event from configured calendar sources.",
		parameters: Type.Object({
			calendarId: Type.String(),
			eventId: Type.String(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const feeds = runtime.personalAssistantAuth?.calendar?.icsFeeds ?? [];
			for (const [index, feed] of feeds.entries()) {
				if (getFeedId(feed, index) !== params.calendarId) continue;
				const events = await fetchIcsFeed(feed, index, runtime.storageDir, signal).catch(async () => await loadCachedFeed(params.calendarId, runtime.storageDir) ?? []);
				const event = events.find((item) => item.id === params.eventId);
				if (event) return { content: [{ type: "text", text: `${event.summary}\n${event.start} → ${event.end}${event.description ? `\n\n${event.description}` : ""}` }], details: { event } };
			}
			const icloud = runtime.personalAssistantAuth?.calendar?.icloud;
			if (icloud?.email && icloud.appPassword) {
				try {
					const calendars = await listICloudCalendars(icloud.email, icloud.appPassword);
					const calendar = calendars.find((entry) => entry.id === params.calendarId || entry.name === params.calendarId);
					if (calendar) {
						const client = await getICloudClient(icloud.email, icloud.appPassword);
						const events = await fetchICloudEvents(client, calendar, 60);
						const event = events.find((item) => item.id === params.eventId);
						if (event) return { content: [{ type: "text", text: `${event.summary}\n${event.start} → ${event.end}${event.description ? `\n\n${event.description}` : ""}` }], details: { event } };
					}
				} catch (error) {
					clearICloudClient(icloud.email, icloud.appPassword);
				}
			}
			return { content: [{ type: "text", text: `Event not found: ${params.calendarId}/${params.eventId}` }], details: {}, isError: true };
		},
	});

	pi.registerTool({
		name: "calendar_create_event",
		label: "Calendar Create Event",
		description: "Create a calendar event in the configured writable calendar.",
		parameters: Type.Object({
			summary: Type.String(),
			start: Type.String(),
			end: Type.String(),
			location: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			allDay: Type.Optional(Type.Boolean()),
			calendarId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const created = await createCalendarEventForContext(ctx, params);
				return {
					content: [{ type: "text", text: `Created event \"${params.summary}\" in ${created.targetCalendar.name}.` }],
					details: created,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("iCloud calendar writing is not configured") || message.startsWith("Invalid start/end timestamps") || message.startsWith("No writable iCloud calendar")) {
					return { content: [{ type: "text", text: message }], details: {}, isError: true };
				}
				clearICloudClient();
				return { content: [{ type: "text", text: `iCloud calendar write failed: ${message}` }], details: {}, isError: true };
			}
		},
	});
}
