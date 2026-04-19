import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ical from "node-ical";
import type { VEvent } from "node-ical";
import icalGenerator from "ical-generator";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import { loadPersonalAssistantRuntime } from "../shared/config.js";
import { ensureDir, getPaCalendarCacheDir } from "../shared/storage.js";
import type { PaCalendarEvent, PaCalendarSource } from "../shared/types.js";

type IcsFeedConfig = {
	id?: string;
	name?: string;
	url?: string;
};

type CachedFeed = {
	fetchedAt: number;
	events: PaCalendarEvent[];
};

type ICloudClient = Awaited<ReturnType<typeof createDAVClient>>;

type ICloudCalendarSource = PaCalendarSource & {
	calendar: DAVCalendar;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map<string, CachedFeed>();
let icloudClientPromise: Promise<ICloudClient> | null = null;

function normalizeFeedUrl(url: string): string {
	return url.startsWith("webcal://") ? `https://${url.slice("webcal://".length)}` : url;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "feed";
}

function getFeedId(feed: IcsFeedConfig, index: number): string {
	return feed.id?.trim() || slugify(feed.name?.trim() || `ics-${index + 1}`);
}

function getFeedName(feed: IcsFeedConfig, index: number): string {
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

function truncate(text: string | undefined, length: number): string | undefined {
	if (!text) return undefined;
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function windowFilter(events: PaCalendarEvent[], days: number, calendarIds?: string[], query?: string): PaCalendarEvent[] {
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

function buildIcsEvents(parsed: Record<string, any>, calendarId: string): PaCalendarEvent[] {
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

async function getICloudClient(email: string, appPassword: string): Promise<ICloudClient> {
	if (!icloudClientPromise) {
		icloudClientPromise = createDAVClient({
			serverUrl: "https://caldav.icloud.com",
			credentials: { username: email, password: appPassword },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});
	}
	try {
		return await icloudClientPromise;
	} catch (error) {
		icloudClientPromise = null;
		throw error;
	}
}

async function listICloudCalendars(email: string, appPassword: string): Promise<ICloudCalendarSource[]> {
	const client = await getICloudClient(email, appPassword);
	const account = await client.createAccount({
		account: { serverUrl: "https://caldav.icloud.com", accountType: "caldav" },
		loadCollections: true,
		loadObjects: false,
	});
	return (account.calendars ?? []).map((calendar) => ({
		id: calendar.url,
		name: typeof calendar.displayName === "string" ? calendar.displayName : String(calendar.displayName ?? calendar.url),
		sourceType: "icloud",
		writable: true,
		readOnly: false,
		calendar,
	}));
}

function buildICloudEvent(calendarId: string, object: DAVCalendarObject): PaCalendarEvent[] {
	if (!object.data || typeof object.data !== "string") return [];
	const parsed = ical.parseICS(object.data);
	const events = buildIcsEvents(parsed, calendarId).map((event) => ({ ...event, sourceType: "icloud" as const }));
	return events.map((event) => ({
		...event,
		id: event.id || object.url,
		description: event.description,
	}));
}

async function fetchICloudEvents(client: ICloudClient, calendar: ICloudCalendarSource, days: number): Promise<PaCalendarEvent[]> {
	const start = new Date();
	const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	const objects = await client.fetchCalendarObjects({
		calendar: calendar.calendar,
		timeRange: {
			start: start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"),
			end: end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"),
		},
		expand: true,
	});
	return objects.flatMap((object) => buildICloudEvent(calendar.id, object as DAVCalendarObject));
}

function formatCalDavTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function selectWritableCalendar(calendars: ICloudCalendarSource[], preferred: string | undefined, requestedId?: string): ICloudCalendarSource | undefined {
	if (requestedId) return calendars.find((calendar) => calendar.id === requestedId || calendar.name === requestedId);
	if (preferred) return calendars.find((calendar) => calendar.id === preferred || calendar.name === preferred);
	return calendars[0];
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
					icloudClientPromise = null;
					warnings.push(`iCloud authentication failed: ${(error as Error).message}`);
				}
			}
			return {
				content: [{ type: "text", text: calendars.length > 0 ? `Found ${calendars.length} calendar source(s).${warnings.length ? ` Warnings: ${warnings.join(" | ")}` : ""}` : `No calendar sources configured.${warnings.length ? ` Warnings: ${warnings.join(" | ")}` : ""}` }],
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
					icloudClientPromise = null;
					warnings.push(`iCloud authentication failed: ${(error as Error).message}`);
				}
			}
			const filtered = windowFilter(events, days, params.calendarIds, params.query).sort((a, b) => a.start.localeCompare(b.start));
			const summary = filtered.length > 0
				? filtered.slice(0, 12).map((event) => `- ${event.start} ${event.summary} (${event.calendarId})`).join("\n")
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
					icloudClientPromise = null;
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
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const icloud = runtime.personalAssistantAuth?.calendar?.icloud;
			if (!icloud?.email || !icloud.appPassword) {
				return { content: [{ type: "text", text: "iCloud calendar writing is not configured. Add personalAssistant.calendar.icloud credentials to magpie.auth.json." }], details: {}, isError: true };
			}
			try {
				const calendars = await listICloudCalendars(icloud.email, icloud.appPassword);
				const defaultCalendar = runtime.personalAssistant?.calendar?.defaultWritableCalendar;
				const targetCalendar = selectWritableCalendar(calendars, defaultCalendar, params.calendarId);
				if (!targetCalendar) {
					return { content: [{ type: "text", text: "No writable iCloud calendar matched the requested/default target." }], details: {}, isError: true };
				}
				const start = new Date(params.start);
				const end = new Date(params.end);
				if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
					return { content: [{ type: "text", text: "Invalid start/end timestamps. Use ISO 8601 and ensure end is after start." }], details: {}, isError: true };
				}
				const uid = randomUUID();
				const cal = icalGenerator({ prodId: "-//magpie//pi-calendar//EN" });
				cal.createEvent({
					id: uid,
					start,
					end,
					summary: params.summary,
					location: params.location,
					description: params.description,
					allDay: params.allDay ?? false,
					stamp: new Date(),
				});
				const client = await getICloudClient(icloud.email, icloud.appPassword);
				await client.createCalendarObject({
					calendar: targetCalendar.calendar,
					iCalString: cal.toString(),
					filename: `${uid}.ics`,
				});
				return {
					content: [{ type: "text", text: `Created event \"${params.summary}\" in ${targetCalendar.name}.` }],
					details: {
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
					},
				};
			} catch (error) {
				icloudClientPromise = null;
				return { content: [{ type: "text", text: `iCloud calendar write failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});
}
