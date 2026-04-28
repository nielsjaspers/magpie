import type { ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { withMailbox } from "./client.js";
import { toMailMessage, type MailMessage } from "./messages.js";

export function buildSearchFallback(query: string | undefined, sinceDays: number, unreadOnly?: boolean): SearchObject {
	const baseSince = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
	const trimmed = query?.trim();
	const base: SearchObject = { since: baseSince };
	if (unreadOnly) base.seen = false;
	if (!trimmed) return { ...base, all: true };
	const fromMatch = trimmed.match(/^from:(.+)$/i);
	if (fromMatch) return { ...base, from: fromMatch[1].trim() };
	const subjectMatch = trimmed.match(/^subject:(.+)$/i);
	if (subjectMatch) return { ...base, subject: subjectMatch[1].trim() };
	return { ...base, text: trimmed };
}

export async function searchMessages(client: ImapFlow, options: { query?: string; label?: string; limit?: number; sinceDays?: number; unreadOnly?: boolean }): Promise<MailMessage[]> {
	const sinceDays = Math.max(1, Math.min(365, options.sinceDays ?? 14));
	const limit = Math.max(1, Math.min(50, options.limit ?? 20));
	const gmailRawParts = [
		options.query?.trim(),
		options.label?.trim() ? `label:${options.label.trim()}` : undefined,
		options.unreadOnly ? "is:unread" : undefined,
		`newer_than:${sinceDays}d`,
	].filter(Boolean);
	const ids = await withMailbox(client, async () => {
		const rawQuery = gmailRawParts.join(" ") || `newer_than:${sinceDays}d`;
		let result = await client.search({ gmailraw: rawQuery }, { uid: true });
		if ((!result || result.length === 0) && (options.query?.trim() || options.unreadOnly)) {
			result = await client.search(buildSearchFallback(options.query, sinceDays, options.unreadOnly), { uid: true });
		}
		if ((!result || result.length === 0) && !options.query?.trim() && !options.unreadOnly) {
			result = await client.search({ all: true }, { uid: true });
		}
		return (result || []).slice(-limit).reverse();
	});
	if (ids.length === 0) return [];
	const messages: MailMessage[] = [];
	await withMailbox(client, async () => {
		for await (const message of client.fetch(ids, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
			source: { start: 0, maxLength: 4096 },
			bodyStructure: true,
		}, { uid: true })) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			messages.push(toMailMessage(message, parsed));
			if (messages.length >= limit) break;
		}
	});
	return messages;
}

export async function fetchFullMessage(client: ImapFlow, id: string): Promise<MailMessage | null> {
	return await withMailbox(client, async () => {
		if (id.startsWith("uid:")) {
			const uid = Number(id.slice("uid:".length));
			const message = await client.fetchOne(uid, {
				uid: true,
				envelope: true,
				flags: true,
				labels: true,
				threadId: true,
				source: true,
				bodyStructure: true,
			}, { uid: true });
			if (!message) return null;
			const parsed = message.source ? await simpleParser(message.source) : null;
			return toMailMessage(message, parsed);
		}
		const selector = id.startsWith("gmail:") ? { emailId: id.slice("gmail:".length) } : ({ emailId: id } as any);
		for await (const message of client.fetch(selector, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
			source: true,
			bodyStructure: true,
		})) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			return toMailMessage(message, parsed);
		}
		return null;
	});
}

export async function fetchThread(client: ImapFlow, threadId: string, limit = 20): Promise<MailMessage[]> {
	const gmailThreadId = threadId.startsWith("thread:") ? threadId.slice("thread:".length) : undefined;
	if (!gmailThreadId) return [];
	const rows: MailMessage[] = [];
	await withMailbox(client, async () => {
		for await (const message of client.fetch({ threadId: gmailThreadId }, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
			source: { start: 0, maxLength: 4096 },
		})) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			rows.push(toMailMessage(message, parsed));
			if (rows.length >= limit) break;
		}
	});
	return rows.sort((a, b) => a.date.localeCompare(b.date));
}
