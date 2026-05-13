import icalGenerator from "ical-generator";
import { randomUUID } from "node:crypto";
import ical from "node-ical";
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import type { PaCalendarEvent, PaCalendarSource } from "../shared/types.js";
import { buildIcsEvents } from "./ics.js";

export type ICloudClient = Awaited<ReturnType<typeof createDAVClient>>;

export type ICloudCalendarSource = PaCalendarSource & {
	calendar: DAVCalendar;
};

const icloudClientPromises = new Map<string, Promise<ICloudClient>>();

export async function getICloudClient(email: string, appPassword: string): Promise<ICloudClient> {
	const cacheKey = `${email}\0${appPassword}`;
	let promise = icloudClientPromises.get(cacheKey);
	if (!promise) {
		promise = createDAVClient({
			serverUrl: "https://caldav.icloud.com",
			credentials: { username: email, password: appPassword },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});
		icloudClientPromises.set(cacheKey, promise);
	}
	try {
		return await promise;
	} catch (error) {
		icloudClientPromises.delete(cacheKey);
		throw error;
	}
}

export function clearICloudClient(email?: string, appPassword?: string) {
	if (email && appPassword) icloudClientPromises.delete(`${email}\0${appPassword}`);
	else icloudClientPromises.clear();
}

export async function listICloudCalendars(email: string, appPassword: string): Promise<ICloudCalendarSource[]> {
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

export function buildICloudEvent(calendarId: string, object: DAVCalendarObject): PaCalendarEvent[] {
	if (!object.data || typeof object.data !== "string") return [];
	const parsed = ical.parseICS(object.data);
	const events = buildIcsEvents(parsed, calendarId).map((event) => ({ ...event, sourceType: "icloud" as const }));
	return events.map((event) => ({
		...event,
		id: event.id || object.url,
		description: event.description,
	}));
}

export async function fetchICloudEvents(client: ICloudClient, calendar: ICloudCalendarSource, days: number): Promise<PaCalendarEvent[]> {
	const start = new Date();
	const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	const objects = await client.fetchCalendarObjects({
		calendar: calendar.calendar,
		timeRange: {
			start: start.toISOString(),
			end: end.toISOString(),
		},
		expand: true,
	});
	return objects.flatMap((object) => buildICloudEvent(calendar.id, object as DAVCalendarObject));
}

export function selectWritableCalendar(calendars: ICloudCalendarSource[], preferred: string | undefined, requestedId?: string): ICloudCalendarSource | undefined {
	if (requestedId) return calendars.find((calendar) => calendar.id === requestedId || calendar.name === requestedId);
	if (preferred) {
		const matched = calendars.find((calendar) => calendar.id === preferred || calendar.name === preferred);
		if (matched) return matched;
	}
	return calendars[0];
}

export function createICloudEventIcs(params: { uid?: string; summary: string; start: Date; end: Date; location?: string; description?: string; allDay?: boolean }): { uid: string; iCalString: string } {
	const uid = params.uid ?? randomUUID();
	const cal = icalGenerator({ prodId: "-//magpie//pi-calendar//EN" });
	cal.createEvent({
		id: uid,
		start: params.start,
		end: params.end,
		summary: params.summary,
		location: params.location,
		description: params.description,
		allDay: params.allDay ?? false,
		stamp: new Date(),
	});
	return { uid, iCalString: cal.toString() };
}
