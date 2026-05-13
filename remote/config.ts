import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { getGlobalConfigPath, getProjectConfigPath, getRemoteConfig, loadConfig } from "../config/config.js";

export type LoadedRemoteConfig = Awaited<ReturnType<typeof loadConfig>>;

export interface ResolvedRemoteHost {
	name: string;
	baseUrl: string;
	deviceToken?: string;
}

export function resolveRemoteHost(config: LoadedRemoteConfig, hostName?: string): ResolvedRemoteHost | undefined {
	const remote = getRemoteConfig(config);
	const targetHost = hostName?.trim() || remote?.defaultHost?.trim();
	if (!targetHost || !remote?.hosts) return undefined;
	const host = remote.hosts[targetHost];
	if (!host) return undefined;
	const baseUrl = host.tailscaleUrl?.trim() || host.publicUrl?.trim();
	if (!baseUrl) return undefined;
	return { name: targetHost, baseUrl, deviceToken: host.deviceToken?.trim() || undefined };
}

export function resolveRemoteHostByName(config: LoadedRemoteConfig, hostName: string, fallback?: ResolvedRemoteHost): ResolvedRemoteHost | undefined {
	const host = config.remote?.hosts?.[hostName];
	if (!host) return fallback;
	const baseUrl = host.tailscaleUrl?.trim() || host.publicUrl?.trim() || fallback?.baseUrl;
	if (!baseUrl) return undefined;
	return {
		name: hostName,
		baseUrl,
		deviceToken: host.deviceToken?.trim() || fallback?.deviceToken,
	};
}

export function getWritableConfigPath(cwd: string): string {
	return existsSync(getProjectConfigPath(cwd)) ? getProjectConfigPath(cwd) : getGlobalConfigPath();
}

export async function writeDeviceTokenToConfig(cwd: string, hostName: string, token: string) {
	const path = getWritableConfigPath(cwd);
	let config: any = {};
	try {
		config = JSON.parse(await readFile(path, "utf8"));
	} catch {
		config = {};
	}
	config.remote ??= {};
	config.remote.hosts ??= {};
	config.remote.hosts[hostName] ??= {};
	config.remote.hosts[hostName].deviceToken = token;
	await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	return path;
}
