import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPersonalAssistantRuntime } from "../shared/config.js";
import type { PaEmailSummary } from "../shared/types.js";
import { getMailboxDebugInfo } from "./client.js";
import { saveMailDraft } from "./drafts.js";
import {
	formatSummaryLines,
	toSummary,
} from "./messages.js";
import { fetchFullMessage, fetchThread, searchMessages } from "./queries.js";
import { withGmailClient } from "./runtime.js";

export async function searchEmailSummariesForContext(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	params: { query?: string; label?: string; limit?: number; sinceDays?: number; unreadOnly?: boolean },
): Promise<PaEmailSummary[]> {
	return await withGmailClient(ctx, async (client) => {
		const messages = await searchMessages(client, params);
		return messages.map(toSummary);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pa-mail-debug", {
		description: "Debug the PA Gmail mailbox connection and counts",
		handler: async (_args, ctx) => {
			try {
				const debug = await withGmailClient(ctx, (client) => getMailboxDebugInfo(client));
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
			try {
				const messages = await withGmailClient(ctx, (client) => searchMessages(client, params), "Gmail aggregation inbox is not configured. Add personalAssistant.mail.gmail credentials to magpie.auth.json.");
				const text = messages.length > 0
					? formatSummaryLines(messages)
					: "No matching messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
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
			try {
				const messages = await withGmailClient(ctx, (client) => searchMessages(client, { label: params.label, limit: params.limit ?? 10, sinceDays: 365, unreadOnly: true }));
				const text = messages.length > 0
					? formatSummaryLines(messages)
					: "No unread messages.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
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
			try {
				const message = await withGmailClient(ctx, (client) => fetchFullMessage(client, params.id));
				if (!message) return { content: [{ type: "text", text: `Message not found: ${params.id}` }], details: {}, isError: true };
				return {
					content: [{ type: "text", text: `From: ${message.from}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${message.body || ""}` }],
					details: { message },
				};
			} catch (error) {
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
			try {
				const messages = await withGmailClient(ctx, (client) => fetchThread(client, params.threadId));
				const text = messages.length > 0 ? formatSummaryLines(messages) : "No messages in thread.";
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary) } };
			} catch (error) {
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
			try {
				const query = `from:${params.person}`;
				const messages = await withGmailClient(ctx, (client) => searchMessages(client, { query, limit: 20, sinceDays: 365 }));
				const text = messages.length > 0 ? formatSummaryLines(messages) : `No recent conversation history for ${params.person}.`;
				return { content: [{ type: "text", text }], details: { messages: messages.map(toSummary), person: params.person } };
			} catch (error) {
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
			try {
				const { target, history, thread } = await withGmailClient(ctx, async (client) => {
					const target = await fetchFullMessage(client, params.messageId);
					if (!target) return { target: null, history: [], thread: [] };
					const history = await searchMessages(client, { query: `from:${target.from}`, limit: params.historyDepth ?? 15, sinceDays: 365 });
					const thread = params.includeThreadContext === false ? [] : await fetchThread(client, target.threadId, 20);
					return { target, history, thread };
				});
				if (!target) return { content: [{ type: "text", text: `Message not found: ${params.messageId}` }], details: {}, isError: true };
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
			const saved = await saveMailDraft({
				storageDir: runtime.storageDir,
				content: params.content,
				subject: params.subject,
				contact: params.contact,
				messageId: params.messageId,
				threadId: params.threadId,
			});
			return {
				content: [{ type: "text", text: `Draft saved to ${saved.historyPath}${saved.contactPath ? ` and ${saved.contactPath}` : ""}.` }],
				details: saved,
			};
		},
	});
}
