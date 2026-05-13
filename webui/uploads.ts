import type { IncomingMessage } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RequestBodyTooLargeError } from "./request.js";

export interface MultipartPart {
	name: string;
	filename?: string;
	contentType?: string;
	data: Buffer;
}

export function sanitizeUploadedFilename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "upload.bin";
}

export const DEFAULT_MULTIPART_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

export async function saveAssistantSessionFiles(sessionPath: string, sessionId: string, files: Array<{ filename?: string; data: Buffer }>) {
	const attachmentDir = resolve(dirname(sessionPath), "attachments", sanitizeUploadedFilename(sessionId));
	await mkdir(attachmentDir, { recursive: true });
	const results: string[] = [];
	for (const file of files) {
		const fileName = sanitizeUploadedFilename(file.filename || "upload.bin");
		const targetPath = resolve(attachmentDir, fileName);
		await writeFile(targetPath, file.data);
		results.push(targetPath);
	}
	return results;
}

export async function saveWorkspaceFiles(workspaceDir: string, files: Array<{ filename: string; data: Buffer }>) {
	const results: string[] = [];
	for (const file of files) {
		const safeName = sanitizeUploadedFilename(file.filename);
		const targetPath = resolve(workspaceDir, safeName);
		if (!targetPath.startsWith(workspaceDir)) throw new Error("Invalid filename");
		await writeFile(targetPath, file.data);
		results.push(targetPath);
	}
	return results;
}

function parseContentLength(req: IncomingMessage): number | undefined {
	const value = req.headers["content-length"];
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseMultipartFormData(req: IncomingMessage, maxBytes = DEFAULT_MULTIPART_BODY_LIMIT_BYTES): Promise<MultipartPart[]> {
	return new Promise((resolve, reject) => {
		const contentType = req.headers["content-type"] || "";
		const match = contentType.match(/boundary=([^;]+)/i);
		if (!match) return reject(new Error("Missing multipart boundary"));
		const contentLength = parseContentLength(req);
		if (contentLength !== undefined && contentLength > maxBytes) {
			reject(new RequestBodyTooLargeError(maxBytes));
			req.destroy();
			return;
		}
		let boundary = match[1].trim();
		if (boundary.startsWith('"') && boundary.endsWith('"')) boundary = boundary.slice(1, -1);

		const chunks: Buffer[] = [];
		let byteLength = 0;
		let rejected = false;
		req.on("data", (chunk) => {
			if (rejected) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			byteLength += buffer.byteLength;
			if (byteLength > maxBytes) {
				rejected = true;
				reject(new RequestBodyTooLargeError(maxBytes));
				req.destroy();
				return;
			}
			chunks.push(buffer);
		});
		req.on("end", () => {
			if (rejected) return;
			try {
				const body = Buffer.concat(chunks);
				const boundaryBuf = Buffer.from(`--${boundary}`);
				const parts: MultipartPart[] = [];

				let idx = 0;
				while (true) {
					idx = body.indexOf(boundaryBuf, idx);
					if (idx === -1) break;
					idx += boundaryBuf.length;

					if (body.slice(idx, idx + 2).toString() === "--") break;

					if (body.slice(idx, idx + 2).toString() === "\r\n") idx += 2;
					else if (body[idx] === 0x0a) idx += 1;

					const nextBoundary = body.indexOf(boundaryBuf, idx);
					if (nextBoundary === -1) break;

					let partEnd = nextBoundary;
					if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;
					else if (body[partEnd - 1] === 0x0a) partEnd -= 1;

					const part = body.slice(idx, partEnd);
					const headerEnd = part.indexOf("\r\n\r\n");
					if (headerEnd === -1) continue;

					const headerStr = part.slice(0, headerEnd).toString("utf8");
					const data = part.slice(headerEnd + 4);

					const nameMatch = headerStr.match(/name="([^"]+)"/);
					const filenameMatch = headerStr.match(/filename="([^"]*)"/);
					const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

					if (nameMatch) {
						parts.push({
							name: nameMatch[1],
							filename: filenameMatch ? filenameMatch[1] : undefined,
							contentType: ctMatch ? ctMatch[1].trim() : undefined,
							data,
						});
					}
					idx = nextBoundary;
				}
				resolve(parts);
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}
