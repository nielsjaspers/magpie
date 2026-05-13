import { describe, expect, test } from "bun:test";
import { resolveContainedPath, sanitizeUploadedFilename } from "../shared/uploads.js";

describe("shared upload filename handling", () => {
	test("rewrites empty, dot, and dot-dot filenames", () => {
		expect(sanitizeUploadedFilename("")).toBe("upload.bin");
		expect(sanitizeUploadedFilename(".")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("..")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("../../notes 1.txt")).toBe("notes-1.txt");
	});

	test("keeps resolved paths inside the target directory", () => {
		const base = "/tmp/magpie-upload-target";
		expect(resolveContainedPath(base, "notes.txt")).toBe("/tmp/magpie-upload-target/notes.txt");
		expect(() => resolveContainedPath(base, "../notes.txt")).toThrow("Invalid filename");
	});
});
