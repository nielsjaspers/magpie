export interface ParsedHttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	text: string;
	json?: unknown;
}

function truncateBody(text: string, maxLength = 500): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength)}...`;
}

export async function parseJsonOrTextResponse(response: Response): Promise<ParsedHttpResponse> {
	const text = await response.text();
	let json: unknown;
	if (text.trim()) {
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
	}
	return {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		text,
		json,
	};
}

export function httpResponseErrorMessage(parsed: ParsedHttpResponse, context?: string): string {
	const record = parsed.json && typeof parsed.json === "object" ? parsed.json as Record<string, unknown> : undefined;
	const jsonMessage = typeof record?.error === "string"
		? record.error
		: typeof record?.message === "string"
			? record.message
			: undefined;
	if (jsonMessage?.trim()) return jsonMessage.trim();

	const status = parsed.statusText
		? `${parsed.status} ${parsed.statusText}`
		: String(parsed.status);
	const prefix = context ? `Request failed ${context}: ${status}` : `Request failed: ${status}`;
	const body = truncateBody(parsed.text);
	return body ? `${prefix}: ${body}` : prefix;
}

export async function readJsonResponse<T>(response: Response, context?: string): Promise<T> {
	const parsed = await parseJsonOrTextResponse(response);
	if (!parsed.ok) throw new Error(httpResponseErrorMessage(parsed, context));
	if (parsed.json === undefined) {
		const status = parsed.statusText
			? `${parsed.status} ${parsed.statusText}`
			: String(parsed.status);
		throw new Error(context ? `Expected JSON response ${context}: ${status}` : `Expected JSON response: ${status}`);
	}
	return parsed.json as T;
}
