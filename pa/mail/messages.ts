import { convert } from "html-to-text";
import type { simpleParser } from "mailparser";
import type { PaEmailSummary } from "../shared/types.js";

export type MailMessage = {
	id: string;
	uid: number;
	emailId?: string;
	threadId: string;
	gmailThreadId?: string;
	from: string;
	to: string[];
	subject: string;
	date: string;
	snippet: string;
	labels: string[];
	isUnread: boolean;
	hasAttachments: boolean;
	body?: string;
	messageId?: string;
};

export function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "contact";
}

export function formatAddressList(addresses?: Array<{ name?: string; address?: string }>): string[] {
	return (addresses ?? []).map((entry) => entry.name && entry.address ? `${entry.name} <${entry.address}>` : (entry.address || entry.name || "")).filter(Boolean);
}

export function firstAddress(addresses?: Array<{ name?: string; address?: string }>): string {
	return formatAddressList(addresses)[0] ?? "Unknown sender";
}

export function normalizeTextBody(input: string | undefined): string {
	if (!input) return "";
	return input
		.replace(/\r\n/g, "\n")
		.replace(/^On .*wrote:\n[\s\S]*$/m, "")
		.replace(/^>.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function messageIdForFetch(message: { emailId?: string; uid: number }): string {
	return message.emailId ? `gmail:${message.emailId}` : `uid:${message.uid}`;
}

export function threadIdForFetch(message: { threadId?: string; uid: number }): string {
	return message.threadId ? `thread:${message.threadId}` : `uid-thread:${message.uid}`;
}

export function toMailMessage(message: any, parsed: Awaited<ReturnType<typeof simpleParser>> | null, bodyText?: string): MailMessage {
	const normalizedBody = normalizeTextBody(bodyText ?? parsed?.text ?? (parsed?.html ? convert(parsed.html as string) : ""));
	return {
		id: messageIdForFetch(message),
		uid: message.uid,
		emailId: message.emailId,
		threadId: threadIdForFetch(message),
		gmailThreadId: message.threadId,
		from: firstAddress(message.envelope?.from),
		to: formatAddressList(message.envelope?.to),
		subject: message.envelope?.subject || "(no subject)",
		date: message.envelope?.date?.toISOString?.() || new Date().toISOString(),
		snippet: normalizedBody.slice(0, 200),
		labels: Array.from(message.labels ?? []),
		isUnread: !(message.flags?.has("\\Seen") ?? false),
		hasAttachments: (parsed?.attachments?.length ?? 0) > 0,
		body: normalizedBody || undefined,
		messageId: parsed?.messageId,
	};
}

export function toSummary(message: MailMessage): PaEmailSummary {
	return {
		id: message.id,
		threadId: message.threadId,
		from: message.from,
		subject: message.subject,
		date: message.date,
		snippet: message.snippet,
		labels: message.labels,
		isUnread: message.isUnread,
	};
}

export function formatSummaryLines(messages: MailMessage[]): string {
	return messages.map((message) => [
		`- id=${message.id}`,
		`thread=${message.threadId}`,
		`${message.date}`,
		`${message.from}`,
		`${message.subject}`,
		message.snippet ? `| ${message.snippet}` : undefined,
	].filter(Boolean).join(" | ")).join("\n");
}
