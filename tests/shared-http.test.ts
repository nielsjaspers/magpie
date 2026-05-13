import { describe, expect, test } from "bun:test";
import { httpResponseErrorMessage, parseJsonOrTextResponse, readJsonResponse } from "../shared/http.js";

describe("shared HTTP response helpers", () => {
	test("reads JSON success responses", async () => {
		const data = await readJsonResponse<{ ok: boolean }>(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
			"for http://host/api",
		);

		expect(data).toEqual({ ok: true });
	});

	test("uses JSON error messages for non-OK responses", async () => {
		await expect(readJsonResponse(
			new Response(JSON.stringify({ error: "not enrolled" }), { status: 401 }),
			"for http://host/api",
		)).rejects.toThrow("not enrolled");
	});

	test("keeps text or HTML error bodies visible", async () => {
		const parsed = await parseJsonOrTextResponse(new Response("<html>bad gateway</html>", {
			status: 502,
			statusText: "Bad Gateway",
		}));

		expect(httpResponseErrorMessage(parsed, "for http://host/api")).toBe("Request failed for http://host/api: 502 Bad Gateway: <html>bad gateway</html>");
	});

	test("reports empty error responses with status context", async () => {
		const parsed = await parseJsonOrTextResponse(new Response("", { status: 504 }));

		expect(httpResponseErrorMessage(parsed)).toBe("Request failed: 504");
	});
});
