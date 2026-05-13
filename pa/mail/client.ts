import { ImapFlow } from "imapflow";
import { firstAddress, messageIdForFetch, threadIdForFetch } from "./messages.js";

let clientPromise: Promise<ImapFlow> | null = null;
let activeClient: ImapFlow | null = null;
let mailboxPathPromise: Promise<string> | null = null;

export async function resetClient() {
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

export async function getClient(address: string, appPassword: string): Promise<ImapFlow> {
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

export async function getMailboxPath(client: ImapFlow): Promise<string> {
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

export async function withMailbox<T>(client: ImapFlow, fn: () => Promise<T>): Promise<T> {
	const mailboxPath = await getMailboxPath(client);
	const lock = await client.getMailboxLock(mailboxPath);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

export async function getMailboxDebugInfo(client: ImapFlow) {
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
