import type { IncomingMessage, ServerResponse } from "node:http";

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => { data += chunk; });
		req.on("end", () => {
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
