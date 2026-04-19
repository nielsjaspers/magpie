import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadPersonalAssistantRuntime } from "../shared/config.js";
import { ensureDir, getPaMailContactDraftsDir, getPaMailHistoryDir } from "../shared/storage.js";
import type { PaEmailSummary } from "../shared/types.js";

type MailMessage = {
	id: string;
	uid: number;
	threadId: string;
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

let clientPromise: Promise<ImapFlow> | null = null;

function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "contact";
}

function formatAddressList(addresses?: Array<{ name?: string; address?: string }>): string[] {
	return (addresses ?? []).map((entry) => entry.name && entry.address ? `${entry.name} <${entry.address}>` : (entry.address || entry.name || "")).filter(Boolean);
}

function firstAddress(addresses?: Array<{ name?: string; address?: string }>): string {
	return formatAddressList(addresses)[0] ?? "Unknown sender";
}

function normalizeTextBody(input: string | undefined): string {
	if (!input) return "";
	return input
		.replace(/\r\n/g, "\n")
		.replace(/^On .*wrote:\n[\s\S]*$/m, "")
		.replace(/^>.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function getClient(address: string, appPassword: string): Promise<ImapFlow> {
	if (!clientPromise) {
		clientPromise = (async () => {
			const client = new ImapFlow({
				host: "imap.gmail.com",
				port: 993,
				secure: true,
				auth: { user: address, pass: appPassword },
			});
			await client.connect();
			return client;
		})();
	}
	try {
		return await clientPromise;
	} catch (error) {
		clientPromise = null;
		throw error;
	}
}

async function withMailbox<T>(client: ImapFlow, fn: () => Promise<T>): Promise<T> {
	const lock = await client.getMailboxLock("[Gmail]/All Mail");
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

async function searchMessages(client: ImapFlow, options: { query?: string; label?: string; limit?: number; sinceDays?: number }): Promise<MailMessage[]> {
	const sinceDays = Math.max(1, Math.min(365, options.sinceDays ?? 14));
	const gmailRawParts = [options.query?.trim(), options.label?.trim() ? `label:${options.label.trim()}` : undefined, `newer_than:${sinceDays}d`].filter(Boolean);
	const ids = await withMailbox(client, async () => {
		const result = await client.search({ gmailraw: gmailRawParts.join(" ") || `newer_than:${sinceDays}d` }, { uid: true });
		return (result || []).slice(-Math.max(1, Math.min(50, options.limit ?? 20))).reverse();
	});
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
		})) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			const rawText = parsed?.text || (parsed?.html ? convert(parsed.html as string) : "");
			messages.push({
				id: message.emailId || String(message.uid),
				uid: message.uid,
				threadId: message.threadId || String(message.uid),
				from: firstAddress(message.envelope?.from),
				to: formatAddressList(message.envelope?.to),
				subject: message.envelope?.subject || "(no subject)",
				date: message.envelope?.date?.toISOString?.() || new Date().toISOString(),
				snippet: normalizeTextBody(rawText).slice(0, 200),
				labels: Array.from(message.labels ?? []),
				isUnread: !(message.flags?.has("\\Seen") ?? false),
				hasAttachments: (parsed?.attachments?.length ?? 0) > 0,
				messageId: parsed?.messageId,
			});
			if (messages.length >= Math.max(1, Math.min(50, options.limit ?? 20))) break;
		}
	});
	return messages;
}

async function fetchFullMessage(client: ImapFlow, id: string): Promise<MailMessage | null> {
	return await withMailbox(client, async () => {
		for await (const message of client.fetch({ emailId: id }, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
			source: true,
			bodyStructure: true,
		})) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			const body = normalizeTextBody(parsed?.text || (parsed?.html ? convert(parsed.html as string) : ""));
			return {
				id: message.emailId || String(message.uid),
				uid: message.uid,
				threadId: message.threadId || String(message.uid),
				from: firstAddress(message.envelope?.from),
				to: formatAddressList(message.envelope?.to),
				subject: message.envelope?.subject || "(no subject)",
				date: message.envelope?.date?.toISOString?.() || new Date().toISOString(),
				snippet: body.slice(0, 200),
				labels: Array.from(message.labels ?? []),
				isUnread: !(message.flags?.has("\\Seen") ?? false),
				hasAttachments: (parsed?.attachments?.length ?? 0) > 0,
				body,
				messageId: parsed?.messageId,
			};
		}
		return null;
	});
}

async function fetchThread(client: ImapFlow, threadId: string, limit = 20): Promise<MailMessage[]> {
	const rows: MailMessage[] = [];
	await withMailbox(client, async () => {
		for await (const message of client.fetch({ threadId }, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
			source: { start: 0, maxLength: 4096 },
		})) {
			const parsed = message.source ? await simpleParser(message.source) : null;
			const rawText = parsed?.text || (parsed?.html ? convert(parsed.html as string) : "");
			rows.push({
				id: message.emailId || String(message.uid),
				uid: message.uid,
				threadId: message.threadId || String(message.uid),
				from: firstAddress(message.envelope?.from),
				to: formatAddressList(message.envelope?.to),
				subject: message.envelope?.subject || "(no subject)",
				date: message.envelope?.date?.toISOString?.() || new Date().toISOString(),
				snippet: normalizeTextBody(rawText).slice(0, 200),
				labels: Array.from(message.labels ?? []),
				isUnread: !(message.flags?.has("\\Seen") ?? false),
				hasAttachments: (parsed?.attachments?.length ?? 0) > 0,
			});
			if (rows.length >= limit) break;
		}
	});
	return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function toSummary(message: MailMessage): PaEmailSummary {
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "email_search",
		label: "Email Search",
		description: "Search messages in the configured Gmail aggregation inbox.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			label: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 20 })),
			sinceDays: Type.Optional(Type.Number({ minimum: 1, maximum: 365, default: 14 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured. Add personalAssistant.mail.gmail credentials to magpie.auth.json." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const messages = await searchMessages(client, params);
				const text = messages.length > 0
					? messages.map((message) => `- ${message.date} | ${message.from} | ${message.subject} | ${message.snippet}`).join("\n")
					: "No matching messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Mail search failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_list_unread",
		label: "Email List Unread",
		description: "List unread messages from the Gmail aggregation inbox.",
		parameters: Type.Object({
			label: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const unreadQuery = ["is:unread", params.label?.trim() ? `label:${params.label.trim()}` : undefined].filter(Boolean).join(" ");
				const messages = await searchMessages(client, { query: unreadQuery, limit: params.limit ?? 10, sinceDays: 30 });
				const text = messages.length > 0
					? messages.map((message) => `- ${message.date} | ${message.from} | ${message.subject} | ${message.snippet}`).join("\n")
					: "No unread messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Unread mail lookup failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_fetch",
		label: "Email Fetch",
		description: "Fetch a full message from the Gmail aggregation inbox.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const message = await fetchFullMessage(client, params.id);
				if (!message) return { content: [{ type: "text", text: `Message not found: ${params.id}` }], details: {}, isError: true };
				return {
					content: [{ type: "text", text: `From: ${message.from}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${message.body || ""}` }],
					details: { message },
				};
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Mail fetch failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_threads",
		label: "Email Threads",
		description: "Fetch summaries for a Gmail thread.",
		parameters: Type.Object({ threadId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const messages = await fetchThread(client, params.threadId);
				const text = messages.length > 0 ? messages.map((message) => `- ${message.date} | ${message.from} | ${message.subject} | ${message.snippet}`).join("\n") : "No messages in thread.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Thread fetch failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_conversation_history",
		label: "Email Conversation History",
		description: "Summarize recent correspondence with a person.",
		parameters: Type.Object({ person: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const query = `from:${params.person} OR to:${params.person}`;
				const messages = await searchMessages(client, { query, limit: 20, sinceDays: 120 });
				const text = messages.length > 0 ? messages.map((message) => `- ${message.date} | ${message.from} | ${message.subject} | ${message.snippet}`).join("\n") : `No recent conversation history for ${params.person}.`;
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary), person: params.person } };
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Conversation history lookup failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_draft_context",
		label: "Email Draft Context",
		description: "Gather the target message, thread, and prior history needed to draft a reply.",
		parameters: Type.Object({
			messageId: Type.String(),
			includeThreadContext: Type.Optional(Type.Boolean({ default: true })),
			historyDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 30, default: 15 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				return { content: [{ type: "text", text: "Gmail aggregation inbox is not configured." }], details: {}, isError: true };
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const target = await fetchFullMessage(client, params.messageId);
				if (!target) return { content: [{ type: "text", text: `Message not found: ${params.messageId}` }], details: {}, isError: true };
				const person = target.from;
				const history = await searchMessages(client, { query: `from:${person} OR to:${person}`, limit: params.historyDepth ?? 15, sinceDays: 180 });
				const thread = params.includeThreadContext === false ? [] : await fetchThread(client, target.threadId, 20);
				return {
					content: [{ type: "text", text: `Draft context loaded for ${target.subject}.` }],
					details: {
						target,
						thread: thread.map(toSummary),
						history: history.map(toSummary),
						person,
					},
				};
			} catch (error) {
				clientPromise = null;
				return { content: [{ type: "text", text: `Draft context lookup failed: ${(error as Error).message}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "email_save_draft",
		label: "Email Save Draft",
		description: "Save a generated draft to local PA storage.",
		parameters: Type.Object({
			content: Type.String(),
			subject: Type.Optional(Type.String()),
			contact: Type.Optional(Type.String()),
			messageId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const historyDir = await ensureDir(getPaMailHistoryDir(runtime.storageDir));
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const draftId = randomUUID();
			const payload = {
				id: draftId,
				savedAt: new Date().toISOString(),
				subject: params.subject,
				contact: params.contact,
				messageId: params.messageId,
				threadId: params.threadId,
				content: params.content,
			};
			const historyPath = resolve(historyDir, `draft-${timestamp}-${draftId}.md`);
			await writeFile(historyPath, [
				`# Draft ${draftId}`,
				"",
				`- savedAt: ${payload.savedAt}`,
				payload.subject ? `- subject: ${payload.subject}` : undefined,
				payload.contact ? `- contact: ${payload.contact}` : undefined,
				payload.messageId ? `- messageId: ${payload.messageId}` : undefined,
				payload.threadId ? `- threadId: ${payload.threadId}` : undefined,
				"",
				"## Content",
				"",
				params.content,
			].filter(Boolean).join("\n"), "utf8");
			let contactPath: string | undefined;
			if (params.contact?.trim()) {
				const contactDir = await ensureDir(getPaMailContactDraftsDir(runtime.storageDir, slugify(params.contact)));
				contactPath = resolve(contactDir, `draft-${timestamp}-${draftId}.md`);
				await writeFile(contactPath, params.content, "utf8");
			}
			return {
				content: [{ type: "text", text: `Draft saved to ${historyPath}${contactPath ? ` and ${contactPath}` : ""}.` }],
				details: { draftId, historyPath, contactPath },
			};
		},
	});
}
