import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir, getPaMailContactDraftsDir, getPaMailHistoryDir } from "../shared/storage.js";
import { slugify } from "./messages.js";

export async function saveMailDraft(input: {
	storageDir: string;
	content: string;
	subject?: string;
	contact?: string;
	messageId?: string;
	threadId?: string;
}) {
	const historyDir = await ensureDir(getPaMailHistoryDir(input.storageDir));
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const draftId = randomUUID();
	const payload = {
		id: draftId,
		savedAt: new Date().toISOString(),
		subject: input.subject,
		contact: input.contact,
		messageId: input.messageId,
		threadId: input.threadId,
		content: input.content,
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
		input.content,
	].filter(Boolean).join("\n"), "utf8");
	let contactPath: string | undefined;
	if (input.contact?.trim()) {
		const contactDir = await ensureDir(getPaMailContactDraftsDir(input.storageDir, slugify(input.contact)));
		contactPath = resolve(contactDir, `draft-${timestamp}-${draftId}.md`);
		await writeFile(contactPath, input.content, "utf8");
	}
	return { draftId, historyPath, contactPath };
}
