import { loadAuthConfig, loadConfig, getPersonalAssistantAuth, getPersonalAssistantConfig, getPersonalAssistantStorageDir } from "../../config/config.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export async function loadPersonalAssistantRuntime(ctx: ExtensionContext) {
	const [config, auth] = await Promise.all([loadConfig(ctx.cwd), loadAuthConfig(ctx.cwd)]);
	return {
		config,
		personalAssistant: getPersonalAssistantConfig(config),
		personalAssistantAuth: getPersonalAssistantAuth(auth),
		storageDir: getPersonalAssistantStorageDir(config),
	};
}
