import { resolve } from "node:path";
import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { loadConfig } from "../config/config.js";
import { CodingSessionHost } from "../runtime/coding-session-host.js";

export type CommandContext = Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]["handler"] extends (args: any, ctx: infer T) => any ? T : never;

export function getMagpieAgentBaseDir() {
	return process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME || "", ".pi/agent");
}

export function getCurrentSessionModelRef(ctx: Pick<CommandContext, "sessionManager"> & { model?: any }): string | undefined {
	const branch = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "model_change") continue;
		if (typeof entry.provider === "string" && typeof entry.modelId === "string") return `${entry.provider}/${entry.modelId}`;
	}
	const currentModel = ctx.model;
	if (currentModel && typeof currentModel.provider === "string" && typeof currentModel.id === "string") return `${currentModel.provider}/${currentModel.id}`;
	if (currentModel && typeof currentModel.providerId === "string" && typeof currentModel.modelId === "string") return `${currentModel.providerId}/${currentModel.modelId}`;
	return undefined;
}

export function createLocalCodingHost(ctx: CommandContext, config: Awaited<ReturnType<typeof loadConfig>>) {
	const authStorage = AuthStorage.create();
	const baseDir = getMagpieAgentBaseDir();
	return new CodingSessionHost({
		hostCwd: ctx.cwd,
		storageDir: resolve(baseDir, "magpie-local-hosted"),
		workspaceRootDir: resolve(baseDir, "magpie-local-workspaces"),
		authStorage,
		modelRegistry: ctx.modelRegistry,
		resolveModel: (ref: string) => {
			const idx = ref.indexOf("/");
			if (idx <= 0 || idx === ref.length - 1) return undefined;
			return ctx.modelRegistry.find(ref.slice(0, idx), ref.slice(idx + 1));
		},
		buildSystemPrompt: async () => "You are a helpful coding assistant. Be concise, careful, and effective.",
		hostId: "magpie-local-coding-host",
		hostRole: "local",
		workspaceArchiveExcludes: config.remote?.tarExclude,
		maxWorkspaceArchiveBytes: config.remote?.maxTarSize,
	});
}
