export type PaCalendarSourceType = "icloud" | "ics";

export interface PaCalendarSource {
	id: string;
	name: string;
	sourceType: PaCalendarSourceType;
	writable: boolean;
	readOnly: boolean;
}

export interface PaCalendarEvent {
	id: string;
	calendarId: string;
	summary: string;
	start: string;
	end: string;
	allDay: boolean;
	location?: string;
	description?: string;
	sourceType: PaCalendarSourceType;
}

export interface PaEmailSummary {
	id: string;
	threadId: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
	labels: string[];
	isUnread: boolean;
}
