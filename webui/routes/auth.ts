import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { DeviceRecord } from "../../remote/types.js";
import {
	authenticateRequest,
	consumeEnrollmentCode,
	createEnrollmentCode,
	isLoopbackRequest,
	type RemoteAuthStore,
} from "../../remote/auth.js";
import { getRequestIp, readBody, recordRateLimit, sendJson } from "../request.js";

export function isPublicWebUiPath(pathname: string): boolean {
	return pathname === "/health"
		|| pathname === "/enroll"
		|| pathname === "/assets/css/style.css"
		|| pathname === "/api/v1/enroll"
		|| pathname === "/api/v1/enroll/code"
		|| pathname === "/api/v1/enroll/claim";
}

export async function authenticateWebUiRequest(input: {
	auth: RemoteAuthStore;
	req: IncomingMessage;
	res: ServerResponse;
	requestUrl: URL;
	enrollmentLimiter: Map<string, number[]>;
	deviceRequestLimiter: Map<string, number[]>;
}): Promise<{ handled: boolean; device?: DeviceRecord }> {
	const { auth, req, res, requestUrl, enrollmentLimiter, deviceRequestLimiter } = input;
	if (isEnrollmentPost(requestUrl.pathname, req.method)) {
		const ip = getRequestIp(req);
		if (!recordRateLimit(enrollmentLimiter, ip, 10, 60 * 60 * 1000)) {
			sendJson(res, 429, { error: "Too many enrollment attempts. Try again later." });
			return { handled: true };
		}
	}
	if (isPublicWebUiPath(requestUrl.pathname) || isLoopbackRequest(req)) return { handled: false };

	const device = await authenticateRequest(auth, req);
	if (!device) {
		if (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/assets/")) {
			res.statusCode = 302;
			res.setHeader("location", "/enroll");
			res.end();
			return { handled: true };
		}
		sendJson(res, 401, { error: "Unauthorized" });
		return { handled: true };
	}
	if (!recordRateLimit(deviceRequestLimiter, device.id, 100, 60 * 1000)) {
		sendJson(res, 429, { error: "Rate limit exceeded. Try again later." });
		return { handled: true };
	}
	return { handled: false, device };
}

export async function handleEnrollmentRoute(input: {
	auth: RemoteAuthStore;
	req: IncomingMessage;
	res: ServerResponse;
	requestUrl: URL;
}): Promise<boolean> {
	const { auth, req, res, requestUrl } = input;
	if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll/code") {
		if (!isLoopbackRequest(req)) {
			const device = await authenticateRequest(auth, req);
			if (!device) {
				sendJson(res, 401, { error: "Unauthorized" });
				return true;
			}
		}
		const result = await createEnrollmentCode(auth);
		sendJson(res, 201, { code: result.code, expiresAt: result.expiresAt });
		return true;
	}
	if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll") {
		const body = await readBody(req);
		const result = await consumeEnrollmentCode(auth, {
			code: String(body.code || ""),
			deviceName: String(body.deviceName || "device"),
			platform: String(body.platform || req.headers["user-agent"] || "web"),
		});
		const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
		const isSecure = requestUrl.protocol === "https:" || forwardedProto === "https";
		res.setHeader("set-cookie", [
			`magpie_token=${encodeURIComponent(result.token)}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Lax",
			"Max-Age=31536000",
			...(isSecure ? ["Secure"] : []),
		].join("; "));
		sendJson(res, 200, { ok: true, device: result.device });
		return true;
	}
	if (req.method === "POST" && requestUrl.pathname === "/api/v1/enroll/claim") {
		const body = await readBody(req);
		const result = await consumeEnrollmentCode(auth, {
			code: String(body.code || ""),
			deviceName: String(body.deviceName || "device"),
			platform: String(body.platform || req.headers["user-agent"] || "cli"),
		});
		sendJson(res, 200, { ok: true, token: result.token, device: result.device });
		return true;
	}
	return false;
}

function isEnrollmentPost(pathname: string, method: string | undefined): boolean {
	return method === "POST" && (
		pathname === "/api/v1/enroll"
		|| pathname === "/api/v1/enroll/claim"
		|| pathname === "/api/v1/enroll/code"
	);
}
