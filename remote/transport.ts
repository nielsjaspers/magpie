import type { ExportedSessionBundle } from "./types.js";

export interface SerializedSessionBundle {
	metadata: ExportedSessionBundle["metadata"];
	sessionJsonlBase64: string;
	workspaceBase64?: string;
	workspaceFormat?: "tar.gz";
}

export function serializeSessionBundle(bundle: ExportedSessionBundle): SerializedSessionBundle {
	return {
		metadata: bundle.metadata,
		sessionJsonlBase64: Buffer.from(bundle.sessionJsonl).toString("base64"),
		workspaceBase64: bundle.workspace ? Buffer.from(bundle.workspace.archive).toString("base64") : undefined,
		workspaceFormat: bundle.workspace?.format,
	};
}

export function deserializeSessionBundle(bundle: SerializedSessionBundle): ExportedSessionBundle {
	return {
		metadata: bundle.metadata,
		sessionJsonl: Buffer.from(bundle.sessionJsonlBase64, "base64"),
		workspace: bundle.workspaceBase64 && bundle.workspaceFormat
			? {
				archive: Buffer.from(bundle.workspaceBase64, "base64"),
				format: bundle.workspaceFormat,
			}
			: undefined,
	};
}
