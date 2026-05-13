import { describe, expect, test } from "bun:test";
import { resolveContainedPath, sanitizeUploadedFilename } from "../shared/uploads.js";

describe("shared upload filename handling", () => {
	test("rewrites empty, dot, and dot-dot filenames", () => {
		expect(sanitizeUploadedFilename("")).toBe("upload.bin");
		expect(sanitizeUploadedFilename(".")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("..")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("/")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("\\")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("../../notes 1.txt")).toBe("notes-1.txt");
	});

	test("preserves useful dots in real filenames", () => {
		expect(sanitizeUploadedFilename(".env")).toBe(".env");
		expect(sanitizeUploadedFilename(".env.local")).toBe(".env.local");
		expect(sanitizeUploadedFilename("archive.tar.gz")).toBe("archive.tar.gz");
		expect(sanitizeUploadedFilename("notes.v1.final.txt")).toBe("notes.v1.final.txt");
	});

	test("keeps only the basename before sanitizing path-like upload names", () => {
		expect(sanitizeUploadedFilename("../../.env")).toBe(".env");
		expect(sanitizeUploadedFilename("..\\..\\.env.local")).toBe(".env.local");
		expect(sanitizeUploadedFilename("/tmp/uploads/archive.tar.gz")).toBe("archive.tar.gz");
		expect(sanitizeUploadedFilename("C:\\Users\\niels\\Desktop\\notes 1.txt")).toBe("notes-1.txt");
		expect(sanitizeUploadedFilename("nested/folder/../notes.md")).toBe("notes.md");
	});

	test("removes unsafe punctuation without reintroducing path structure", () => {
		expect(sanitizeUploadedFilename("my report (final).pdf")).toBe("my-report-final-.pdf");
		expect(sanitizeUploadedFilename("semi;colon&pipe|name.txt")).toBe("semi-colon-pipe-name.txt");
		expect(sanitizeUploadedFilename("../../../..")).toBe("upload.bin");
		expect(sanitizeUploadedFilename("../../...")).toBe("...");
		expect(sanitizeUploadedFilename(".. / .. / secret.txt")).toBe("secret.txt");
	});

	test("keeps resolved paths inside the target directory", () => {
		const base = "/tmp/magpie-upload-target";
		expect(resolveContainedPath(base, "notes.txt")).toBe("/tmp/magpie-upload-target/notes.txt");
		expect(() => resolveContainedPath(base, "../notes.txt")).toThrow("Invalid filename");
		expect(() => resolveContainedPath(base, "/tmp/notes.txt")).toThrow("Invalid filename");
	});
});
