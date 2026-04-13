export function resolveSubagentHeaders(
	baseHeaders: Record<string, string> | undefined,
	model: { provider?: string } | undefined,
	isSubagent: boolean,
): Record<string, string> {
	const headers = { ...(baseHeaders ?? {}) };
	if (!isSubagent) return headers;
	if (model?.provider === "github-copilot") {
		headers["X-Initiator"] = "agent";
		headers["x-initiator"] = "agent";
		headers["Openai-Intent"] = "conversation-edits";
	}
	return headers;
}
