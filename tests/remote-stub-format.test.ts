import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { formatRemoteHosts } from "../remote/format.js";
import { parseDispatchedStubEntry, resolveCurrentStub } from "../remote/stub.js";

describe("remote stub and formatting helpers", () => {
	test("parses dispatched stub entries", () => {
		const stub = parseDispatchedStubEntry({
			type: "custom",
			customType: "magpie:dispatched-stub",
			data: { remoteHost: "home", remoteSessionId: "s1" },
		});

		expect(stub).toEqual({ remoteHost: "home", remoteSessionId: "s1" });
		expect(parseDispatchedStubEntry({ type: "message" })).toBeUndefined();
	});

	test("resolves current stub from entries before falling back to session file", async () => {
		const sessionFile = resolve(await mkdtemp(resolve(tmpdir(), "magpie-remote-stub-")), "session.jsonl");
		await writeFile(sessionFile, JSON.stringify({
			type: "custom",
			customType: "magpie:dispatched-stub",
			data: { remoteHost: "file", remoteSessionId: "file-session" },
		}) + "\n", "utf8");

		const fromFile = await resolveCurrentStub({
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => sessionFile,
			},
		});
		const fromEntries = await resolveCurrentStub({
			sessionManager: {
				getEntries: () => [{
					type: "custom",
					customType: "magpie:dispatched-stub",
					data: { remoteHost: "entries", remoteSessionId: "entry-session" },
				}],
				getSessionFile: () => sessionFile,
			},
		});

		expect(fromFile).toMatchObject({ remoteHost: "file", remoteSessionId: "file-session" });
		expect(fromEntries).toMatchObject({ remoteHost: "entries", remoteSessionId: "entry-session" });
	});

	test("formats configured remote hosts with default and token state", () => {
		expect(formatRemoteHosts({ remote: { hosts: {} } })).toBe("No remote hosts configured.");
		expect(formatRemoteHosts({
			remote: {
				defaultHost: "home",
				hosts: {
					home: { tailscaleUrl: "http://home", deviceToken: "token" },
					lab: { publicUrl: "https://lab" },
				},
			},
		})).toContain("home [default]\n- http://home\n- token: configured");
	});
});
