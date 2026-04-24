import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRemoteAuthStore, consumeEnrollmentCode, createEnrollmentCode, extractBearerToken, isLoopbackRequest, revokeEnrolledDevice, authenticateRequest } from "../remote/auth.js";

function request(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
	return {
		headers,
		socket: { remoteAddress },
	} as any;
}

describe("remote auth", () => {
	test("extracts bearer token before cookie token and decodes cookie fallback", () => {
		expect(extractBearerToken(request({ authorization: "Bearer abc", cookie: "magpie_token=def" }))).toBe("abc");
		expect(extractBearerToken(request({ cookie: "theme=x; magpie_token=a%3Db%3Dc" }))).toBe("a=b=c");
		expect(extractBearerToken(request({ cookie: "theme=x" }))).toBeUndefined();
	});

	test("detects loopback request address variants", () => {
		expect(isLoopbackRequest(request({}, "127.0.0.1"))).toBe(true);
		expect(isLoopbackRequest(request({}, "::1"))).toBe(true);
		expect(isLoopbackRequest(request({}, "::ffff:127.0.0.1"))).toBe(true);
		expect(isLoopbackRequest(request({}, "10.0.0.2"))).toBe(false);
	});

	test("enrolls, authenticates, and revokes device tokens", async () => {
		const baseDir = await mkdtemp(resolve(tmpdir(), "magpie-auth-test-"));
		await mkdir(baseDir, { recursive: true });
		const store = createRemoteAuthStore(baseDir);
		const code = await createEnrollmentCode(store, 5);
		const { device, token } = await consumeEnrollmentCode(store, { code: code.code.toLowerCase(), deviceName: "Laptop", platform: "darwin" });

		expect(device.name).toBe("Laptop");
		expect(await authenticateRequest(store, request({ authorization: `Bearer ${token}` }))).toMatchObject({ id: device.id, revoked: false });
		await revokeEnrolledDevice(store, device.id);
		expect(await authenticateRequest(store, request({ authorization: `Bearer ${token}` }))).toBeUndefined();
	});
});
