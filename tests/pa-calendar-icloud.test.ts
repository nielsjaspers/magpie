import { describe, expect, test } from "bun:test";
import { buildICloudEvent, createICloudEventIcs, selectWritableCalendar } from "../pa/calendar/icloud.js";

describe("PA calendar iCloud helpers", () => {
	test("selects requested, preferred, then first writable calendar", () => {
		const calendars = [
			{ id: "a", name: "A", sourceType: "icloud" as const, writable: true, readOnly: false, calendar: {} as any },
			{ id: "b", name: "B", sourceType: "icloud" as const, writable: true, readOnly: false, calendar: {} as any },
		];
		expect(selectWritableCalendar(calendars, undefined, "B")?.id).toBe("b");
		expect(selectWritableCalendar(calendars, "b")?.id).toBe("b");
		expect(selectWritableCalendar(calendars, undefined)?.id).toBe("a");
	});

	test("creates event ICS and parses CalDAV objects", () => {
		const start = new Date("2026-01-01T10:00:00.000Z");
		const end = new Date("2026-01-01T11:00:00.000Z");
		const created = createICloudEventIcs({ uid: "uid-1", summary: "Meeting", start, end });
		expect(created.uid).toBe("uid-1");
		expect(created.iCalString).toContain("SUMMARY:Meeting");

		const events = buildICloudEvent("cal", { url: "obj", data: created.iCalString } as any);
		expect(events[0]).toMatchObject({ calendarId: "cal", summary: "Meeting", sourceType: "icloud" });
	});
});
