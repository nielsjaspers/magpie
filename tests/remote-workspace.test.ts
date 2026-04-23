import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	createWorkspaceArchiveFromDir,
	ensureCleanDirectory,
	ensureParentDir,
	extractWorkspaceArchiveToDir,
	readWorkspaceFile,
} from "../remote/workspace.js";

describe("remote workspace archive helpers", () => {
	test("archives, extracts, and preserves nested files", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "magpie-workspace-source-"));
		const target = await mkdtemp(resolve(tmpdir(), "magpie-workspace-target-"));
		await mkdir(resolve(source, "nested"), { recursive: true });
		await writeFile(resolve(source, "nested", "file.txt"), "hello", "utf8");

		const archive = await createWorkspaceArchiveFromDir(source);
		await extractWorkspaceArchiveToDir(archive, target);

		expect(await readFile(resolve(target, "nested", "file.txt"), "utf8")).toBe("hello");
	});

	test("honors exclude patterns and max archive size", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "magpie-workspace-source-"));
		const target = await mkdtemp(resolve(tmpdir(), "magpie-workspace-target-"));
		await writeFile(resolve(source, "keep.txt"), "keep", "utf8");
		await writeFile(resolve(source, "secret.txt"), "secret", "utf8");

		const archive = await createWorkspaceArchiveFromDir(source, { excludes: ["secret.txt"] });
		await extractWorkspaceArchiveToDir(archive, target);

		expect(await readFile(resolve(target, "keep.txt"), "utf8")).toBe("keep");
		expect(readFile(resolve(target, "secret.txt"), "utf8")).rejects.toThrow();
		await expect(createWorkspaceArchiveFromDir(source, { maxBytes: 1 })).rejects.toThrow("Workspace archive exceeds maxBytes");
	});

	test("cleans directories and creates parent directories for file paths", async () => {
		const base = await mkdtemp(resolve(tmpdir(), "magpie-workspace-dir-"));
		const dir = resolve(base, "clean");
		await mkdir(dir, { recursive: true });
		await writeFile(resolve(dir, "old.txt"), "old", "utf8");

		await ensureCleanDirectory(dir);
		await expect(readFile(resolve(dir, "old.txt"), "utf8")).rejects.toThrow();

		const nestedFile = resolve(base, "a", "b", "file.txt");
		await ensureParentDir(nestedFile);
		await writeFile(nestedFile, "new", "utf8");
		expect((await readWorkspaceFile(nestedFile)).toString("utf8")).toBe("new");
	});
});
