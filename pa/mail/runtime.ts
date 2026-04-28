import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadPersonalAssistantRuntime } from "../shared/config.js";
import { getClient, resetClient } from "./client.js";

export async function withGmailClient<T>(
	ctx: ExtensionContext,
	action: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>,
	missingMessage = "Gmail aggregation inbox is not configured.",
): Promise<T> {
	const runtime = await loadPersonalAssistantRuntime(ctx);
	const gmail = runtime.personalAssistantAuth?.mail?.gmail;
	if (!gmail?.address || !gmail.appPassword) throw new Error(missingMessage);
	try {
		const client = await getClient(gmail.address, gmail.appPassword);
		return await action(client);
	} catch (error) {
		await resetClient();
		throw error;
	}
}
