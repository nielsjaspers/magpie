import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
	statusCode = 413;

	constructor(limitBytes: number) {
		super(`Request body exceeds ${limitBytes} bytes`);
		this.name = "RequestBodyTooLargeError";
	}
}

function parseContentLength(req: IncomingMessage): number | undefined {
	const value = req.headers["content-length"];
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function readBody(req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const contentLength = parseContentLength(req);
		if (contentLength !== undefined && contentLength > maxBytes) {
			reject(new RequestBodyTooLargeError(maxBytes));
			req.destroy();
			return;
		}
		let data = "";
		let byteLength = 0;
		let rejected = false;
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			if (rejected) return;
			byteLength += Buffer.byteLength(chunk, "utf8");
			if (byteLength > maxBytes) {
				rejected = true;
				reject(new RequestBodyTooLargeError(maxBytes));
				req.destroy();
				return;
			}
			data += chunk;
		});
		req.on("end", () => {
			if (rejected) return;
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

export function startSse(res: ServerResponse) {
	res.statusCode = 200;
	res.setHeader("content-type", "text/event-stream; charset=utf-8");
	res.setHeader("cache-control", "no-cache, no-transform");
	res.setHeader("connection", "keep-alive");
	res.setHeader("x-accel-buffering", "no");
	res.write(": connected\n\n");
}

export function sendSseEvent(res: ServerResponse, event: unknown) {
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function recordRateLimit(map: Map<string, number[]>, key: string, maxEvents: number, windowMs: number): boolean {
	const now = Date.now();
	const cutoff = now - windowMs;
	const events = (map.get(key) ?? []).filter((value) => value > cutoff);
	events.push(now);
	map.set(key, events);
	return events.length <= maxEvents;
}

export function getRequestIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
	return req.socket.remoteAddress || "unknown";
}

export function getSessionIdFromRequestPath(pathname: string): { sessionId: string; suffix: string } | undefined {
	const prefix = "/api/v1/sessions/";
	if (!pathname.startsWith(prefix)) return undefined;
	const rest = pathname.slice(prefix.length);
	if (!rest) return undefined;
	const slash = rest.indexOf("/");
	if (slash < 0) return { sessionId: decodeURIComponent(rest), suffix: "" };
	return {
		sessionId: decodeURIComponent(rest.slice(0, slash)),
		suffix: rest.slice(slash),
	};
}
