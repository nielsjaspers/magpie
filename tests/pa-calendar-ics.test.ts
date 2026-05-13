import { describe, expect, test } from "bun:test";
import { buildIcsEvents, getFeedId, getFeedName, normalizeFeedUrl, truncate, windowFilter } from "../pa/calendar/ics.js";

describe("PA calendar ICS helpers", () => {
	test("normalizes feed metadata and URLs", () => {
		expect(normalizeFeedUrl("webcal://example.com/feed.ics")).toBe("https://example.com/feed.ics");
		expect(getFeedId({ name: "Work Calendar" }, 0)).toBe("work-calendar");
		expect(getFeedName({}, 1)).toBe("ICS Feed 2");
		expect(truncate("abcdef", 4)).toBe("abc…");
	});

	test("builds and filters ICS events", () => {
		const now = new Date();
		const later = new Date(now.getTime() + 60 * 60 * 1000);
		const events = buildIcsEvents({
			"1": {
				type: "VEVENT",
				uid: "event-1",
				start: now,
				end: later,
				summary: "Planning",
				datetype: "date-time",
			},
		}, "cal");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: "event-1", calendarId: "cal", summary: "Planning", sourceType: "ics" });
		expect(windowFilter(events, 1, ["cal"], "plan")).toHaveLength(1);
		expect(windowFilter(events, 1, ["other"], "plan")).toHaveLength(0);
	});
});
