import type { MagpieConfig } from "../config/types.js";

export function formatExpiry(expiresAt: string): string {
	const ms = Date.parse(expiresAt) - Date.now();
	const minutes = Math.max(0, Math.round(ms / 60000));
	return `${expiresAt} (${minutes} min)`;
}

export function formatRemoteHosts(config: Pick<MagpieConfig, "remote">) {
	const hosts = config.remote?.hosts ?? {};
	const defaultHost = config.remote?.defaultHost?.trim();
	const entries = Object.entries(hosts);
	if (entries.length === 0) return "No remote hosts configured.";
	return entries.map(([name, host]) => {
		const marker = name === defaultHost ? " [default]" : "";
		const urls = [host.tailscaleUrl?.trim(), host.publicUrl?.trim()].filter(Boolean).join(" | ") || "(no url configured)";
		const token = host.deviceToken?.trim() ? "token: configured" : "token: missing";
		return `${name}${marker}\n- ${urls}\n- ${token}`;
	}).join("\n\n");
}
