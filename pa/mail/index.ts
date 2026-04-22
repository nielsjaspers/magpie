import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ImapFlow, type SearchObject } from "imapflow";
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

let clientPromise: Promise<ImapFlow> | null = null;
let activeClient: ImapFlow | null = null;
let mailboxPathPromise: Promise<string> | null = null;

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

async function resetClient() {
	const client = activeClient;
	activeClient = null;
	clientPromise = null;
	mailboxPathPromise = null;
	if (client) {
		try {
			client.close();
		} catch {
			// ignore
		}
	}
}

async function getClient(address: string, appPassword: string): Promise<ImapFlow> {
	if (!clientPromise) {
		clientPromise = (async () => {
			const client = new ImapFlow({
				host: "imap.gmail.com",
				port: 993,
				secure: true,
				auth: { user: address, pass: appPassword },
				disableAutoIdle: true,
				socketTimeout: 0,
				logger: false,
			});
			client.on("error", () => {
				void resetClient();
			});
			client.on("close", () => {
				void resetClient();
			});
			await client.connect();
			activeClient = client;
			return client;
		})();
	}
	try {
		return await clientPromise;
	} catch (error) {
		await resetClient();
		throw error;
	}
}

async function getMailboxPath(client: ImapFlow): Promise<string> {
	if (!mailboxPathPromise) {
		mailboxPathPromise = (async () => {
			const boxes = await client.list();
			const allMail = boxes.find((box) => box.specialUse === "\\All");
			if (allMail?.path) return allMail.path;
			const fallback = boxes.find((box) => box.path === "[Gmail]/All Mail" || box.path === "INBOX");
			return fallback?.path || "INBOX";
		})();
	}
	return await mailboxPathPromise;
}

async function withMailbox<T>(client: ImapFlow, fn: () => Promise<T>): Promise<T> {
	const mailboxPath = await getMailboxPath(client);
	const lock = await client.getMailboxLock(mailboxPath);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

async function getMailboxDebugInfo(client: ImapFlow) {
	const boxes = await client.list({ statusQuery: { messages: true, unseen: true, recent: true } });
	const selectedPath = await getMailboxPath(client);
	const latest: Array<Record<string, unknown>> = [];
	await withMailbox(client, async () => {
		const ids = await client.search({ all: true }, { uid: true });
		const latestIds = (ids || []).slice(-5).reverse();
		for await (const message of client.fetch(latestIds, {
			uid: true,
			envelope: true,
			flags: true,
			labels: true,
			threadId: true,
		}, { uid: true })) {
			latest.push({
				id: messageIdForFetch(message),
				threadId: threadIdForFetch(message),
				uid: message.uid,
				subject: message.envelope?.subject || "(no subject)",
				from: firstAddress(message.envelope?.from),
				date: message.envelope?.date?.toISOString?.() || null,
				labels: Array.from(message.labels ?? []),
				flags: Array.from(message.flags ?? []),
			});
		}
	});
	return {
		selectedPath,
		mailboxes: boxes.map((box) => ({
			path: box.path,
			specialUse: box.specialUse,
			messages: box.status?.messages,
			unseen: box.status?.unseen,
			recent: box.status?.recent,
		})),
		latest,
	};
}

function buildSearchFallback(query: string | undefined, sinceDays: number, unreadOnly?: boolean): SearchObject {
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

function messageIdForFetch(message: { emailId?: string; uid: number }): string {
	return message.emailId ? `gmail:${message.emailId}` : `uid:${message.uid}`;
}

function threadIdForFetch(message: { threadId?: string; uid: number }): string {
	return message.threadId ? `thread:${message.threadId}` : `uid-thread:${message.uid}`;
}

function toMailMessage(message: any, parsed: Awaited<ReturnType<typeof simpleParser>> | null, bodyText?: string): MailMessage {
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

async function searchMessages(client: ImapFlow, options: { query?: string; label?: string; limit?: number; sinceDays?: number; unreadOnly?: boolean }): Promise<MailMessage[]> {
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

async function fetchFullMessage(client: ImapFlow, id: string): Promise<MailMessage | null> {
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

async function fetchThread(client: ImapFlow, threadId: string, limit = 20): Promise<MailMessage[]> {
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

function formatSummaryLines(messages: MailMessage[]): string {
	return messages.map((message) => [
		`- id=${message.id}`,
		`thread=${message.threadId}`,
		`${message.date}`,
		`${message.from}`,
		`${message.subject}`,
		message.snippet ? `| ${message.snippet}` : undefined,
	].filter(Boolean).join(" | ")).join("\n");
}

export async function searchEmailSummariesForContext(
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
	params: { query?: string; label?: string; limit?: number; sinceDays?: number; unreadOnly?: boolean },
): Promise<PaEmailSummary[]> {
	const runtime = await loadPersonalAssistantRuntime(ctx);
	const gmail = runtime.personalAssistantAuth?.mail?.gmail;
	if (!gmail?.address || !gmail.appPassword) throw new Error("Gmail aggregation inbox is not configured.");
	try {
		const client = await getClient(gmail.address, gmail.appPassword);
		const messages = await searchMessages(client, params);
		return messages.map(toSummary);
	} catch (error) {
		await resetClient();
		throw error;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pa-mail-debug", {
		description: "Debug the PA Gmail mailbox connection and counts",
		handler: async (_args, ctx) => {
			const runtime = await loadPersonalAssistantRuntime(ctx);
			const gmail = runtime.personalAssistantAuth?.mail?.gmail;
			if (!gmail?.address || !gmail.appPassword) {
				ctx.ui.notify("Gmail aggregation inbox is not configured.", "error");
				return;
			}
			try {
				const client = await getClient(gmail.address, gmail.appPassword);
				const debug = await getMailboxDebugInfo(client);
				const mailboxLines = debug.mailboxes.map((box) => `- ${box.path}${box.specialUse ? ` [${box.specialUse}]` : ""} | messages=${box.messages ?? "?"} unseen=${box.unseen ?? "?"} recent=${box.recent ?? "?"}`);
				const latestLines = debug.latest.map((row) => `- ${row.id} | ${row.date ?? "no-date"} | ${row.from} | ${row.subject}`);
				ctx.ui.notify([
					`Selected mailbox: ${debug.selectedPath}`,
					"",
					"Mailboxes:",
					...(mailboxLines.length > 0 ? mailboxLines : ["- none"]),
					"",
					"Latest messages:",
					...(latestLines.length > 0 ? latestLines : ["- none"]),
				].join("\n"), "info");
			} catch (error) {
				await resetClient();
				ctx.ui.notify(`PA mail debug failed: ${(error as Error).message}`, "error");
			}
		},
	});

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
					? formatSummaryLines(messages)
					: "No matching messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				await resetClient();
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
				const messages = await searchMessages(client, { label: params.label, limit: params.limit ?? 10, sinceDays: 365, unreadOnly: true });
				const text = messages.length > 0
					? formatSummaryLines(messages)
					: "No unread messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				await resetClient();
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
				await resetClient();
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
				const text = messages.length > 0 ? formatSummaryLines(messages) : "No messages in thread.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
				await resetClient();
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
				const query = `from:${params.person}`;
				const messages = await searchMessages(client, { query, limit: 20, sinceDays: 365 });
				const text = messages.length > 0 ? formatSummaryLines(messages) : `No recent conversation history for ${params.person}.`;
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary), person: params.person } };
			} catch (error) {
				await resetClient();
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
				const history = await searchMessages(client, { query: `from:${target.from}`, limit: params.historyDepth ?? 15, sinceDays: 365 });
				const thread = params.includeThreadContext === false ? [] : await fetchThread(client, target.threadId, 20);
				return {
					content: [{ type: "text", text: `Draft context loaded for ${target.subject}.` }],
					details: {
						target,
						thread: thread.map(toSummary),
						history: history.map(toSummary),
						person: target.from,
					},
				};
			} catch (error) {
				await resetClient();
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
