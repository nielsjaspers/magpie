import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { JsonStoreCorruptionError, normalizeRecord, readJsonStore, writeJsonStore } from "../shared/json-store.js";

describe("shared JSON store", () => {
	test("normalizes missing and malformed-shaped stores without data loss writes", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "magpie-json-store-"));
		const path = resolve(dir, "index.json");

		expect(await readJsonStore(path, normalizeRecord<{ ok: boolean }>)).toEqual({});
		await writeJsonStore(path, { a: { ok: true } });
		expect(await readJsonStore(path, normalizeRecord<{ ok: boolean }>)).toEqual({ a: { ok: true } });
		expect(await readFile(path, "utf8")).toEndWith("\n");
	});

	test("surfaces corrupt JSON instead of returning an empty registry", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "magpie-json-store-"));
		const path = resolve(dir, "index.json");
		await writeFile(path, "{ nope", "utf8");

		await expect(readJsonStore(path, normalizeRecord)).rejects.toBeInstanceOf(JsonStoreCorruptionError);
	});
});
