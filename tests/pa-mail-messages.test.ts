import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { saveMailDraft } from "../pa/mail/drafts.js";
import { formatSummaryLines, normalizeTextBody, slugify, toSummary, type MailMessage } from "../pa/mail/messages.js";
import { buildSearchFallback } from "../pa/mail/queries.js";
import { withGmailClient } from "../pa/mail/runtime.js";

function message(patch: Partial<MailMessage> = {}): MailMessage {
	return {
		id: "gmail:1",
		uid: 1,
		threadId: "thread:1",
		from: "Ada <ada@example.com>",
		to: [],
		subject: "Hello",
		date: "2026-01-01T00:00:00.000Z",
		snippet: "Short body",
		labels: ["INBOX"],
		isUnread: true,
		hasAttachments: false,
		...patch,
	};
}

describe("PA mail message and draft helpers", () => {
	test("normalizes reply text and formats summaries", () => {
		expect(slugify("Ada Lovelace <Ada@example.com>")).toBe("ada-lovelace-ada-example-com");
		expect(normalizeTextBody("Hi\r\n\r\n> quoted\n\n\nOn yesterday wrote:\nold")).toBe("Hi");
		expect(toSummary(message())).toMatchObject({ id: "gmail:1", subject: "Hello", isUnread: true });
		expect(formatSummaryLines([message()])).toContain("thread=thread:1");
	});

	test("saves draft history and contact copies", async () => {
		const storageDir = await mkdtemp(resolve(tmpdir(), "magpie-mail-drafts-"));
		const saved = await saveMailDraft({
			storageDir,
			content: "Draft body",
			subject: "Subject",
			contact: "Ada Lovelace",
			messageId: "gmail:1",
		});

		expect(await readFile(saved.historyPath, "utf8")).toContain("Draft body");
		expect(saved.contactPath).toBeString();
		expect(await readFile(saved.contactPath!, "utf8")).toBe("Draft body");
	});

	test("builds IMAP fallback search objects", () => {
		expect(buildSearchFallback("from:ada@example.com", 14)).toMatchObject({ from: "ada@example.com" });
		expect(buildSearchFallback("subject:hello", 14, true)).toMatchObject({ subject: "hello", seen: false });
		expect(buildSearchFallback(undefined, 14)).toMatchObject({ all: true });
	});

	test("fails before opening Gmail when credentials are missing", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = await mkdtemp(resolve(tmpdir(), "magpie-mail-runtime-"));
		try {
			await expect(withGmailClient({ cwd: process.env.PI_CODING_AGENT_DIR } as any, async () => "unused")).rejects.toThrow("Gmail aggregation inbox is not configured.");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
