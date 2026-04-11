/**
 * Session Query extension
 *
 * Adapted from pi-amplike/extensions/session-query.ts.
 *
 * Lets the agent query prior Pi sessions for decisions, file changes, and context.
 * Works especially well with handoff prompts that include:
 *   **Parent session:** `/absolute/path/to/session.jsonl`
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	SessionManager,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

type RuntimeModel = NonNullable<ExtensionContext["model"]>;

function getModelKey(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function addModelCandidate(candidates: RuntimeModel[], model: RuntimeModel | undefined): void {
	if (!model) return;
	if (candidates.some((candidate) => getModelKey(candidate) === getModelKey(model))) return;
	candidates.push(model);
}

function messageToText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			return (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				"text" in block &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			);
		})
		.map((block) => block.text)
		.join("\n");
}

function normalizeSessionPath(raw: string): string {
	return raw.trim().replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").trim();
}

function parseParentSessionPath(text: string): string | undefined {
	const markdownMatch = text.match(/\*\*Parent session:\*\*\s*`([^`]+)`/i);
	if (markdownMatch?.[1]) return normalizeSessionPath(markdownMatch[1]);

	const plainMatch = text.match(/Parent session:\s*([^\n]+)/i);
	if (plainMatch?.[1]) return normalizeSessionPath(plainMatch[1]);

	return undefined;
}

function findParentSessionPathFromCurrentBranch(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message as { content?: unknown });

	for (let i = messages.length - 1; i >= 0; i--) {
		const text = messageToText(messages[i]!);
		const path = parseParentSessionPath(text);
		if (path) return path;
	}

	return undefined;
}

function resolveSessionPath(inputPath: string, cwd: string): string {
	if (inputPath.startsWith("/")) return inputPath;
	if (inputPath.startsWith("~")) return inputPath.replace("~", process.env.HOME ?? "~");
	return resolve(cwd, inputPath);
}

async function resolveQueryModelAndAuth(ctx: ExtensionContext, sessionBranch: SessionEntry[]) {
	const candidates: RuntimeModel[] = [];

	const modelChanges = sessionBranch.filter(
		(entry): entry is SessionEntry & { type: "model_change"; provider: string; modelId: string } =>
			entry.type === "model_change",
	);
	if (modelChanges.length > 0) {
		const lastChange = modelChanges[modelChanges.length - 1]!;
		addModelCandidate(candidates, ctx.modelRegistry.find(lastChange.provider, lastChange.modelId) as RuntimeModel | undefined);
	}

	addModelCandidate(candidates, ctx.model as RuntimeModel | undefined);

	for (const model of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) {
			return { model, apiKey: auth.apiKey, headers: auth.headers };
		}
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_query",
		label: (params) => `Session Query: ${params.question}`,
		description:
			"Query a previous Pi session for context, decisions, file changes, and implementation details.",
		promptSnippet: "Use this when you need details from a parent or earlier session.",
		promptGuidelines: [
			"Prefer specific questions (files changed, decisions, rationale, unresolved issues).",
			"If sessionPath is omitted, it will try to use **Parent session:** from the current thread.",
		],
		renderResult: (result, _options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const parsed = text.match(/\*\*Query:\*\* ([\s\S]+?)\n\*\*Session:\*\* ([^\n]+)\n\n---\n\n([\s\S]+)/);

			if (parsed) {
				const [, query, sessionPath, answer] = parsed;
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query.trim()), 0, 0));
				container.addChild(new Text(theme.bold("Session: ") + theme.fg("muted", sessionPath.trim()), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (value: string) => theme.fg("toolOutput", value),
					}),
				);
				return container;
			}

			container.addChild(new Text(theme.fg("toolOutput", text || "(no output)"), 0, 0));
			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.Optional(
				Type.String({
					description:
						"Session file path (.jsonl). Optional when current thread includes **Parent session:** metadata.",
				}),
			),
			question: Type.String({
				description:
					"Question to ask about the session (e.g., 'What files were modified?' or 'What approach was chosen?').",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const question = params.question?.trim();
			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				isError: true,
			});

			if (!question) {
				return errorResult("Missing question.");
			}

			const explicitPath = params.sessionPath ? normalizeSessionPath(params.sessionPath) : undefined;
			const inferredPath = explicitPath ? undefined : findParentSessionPathFromCurrentBranch(ctx);
			const rawSessionPath = explicitPath || inferredPath;

			if (!rawSessionPath) {
				return errorResult(
					"Missing sessionPath. Provide it explicitly, or run from a handoff thread that includes **Parent session:** metadata.",
				);
			}

			const sessionPath = resolveSessionPath(rawSessionPath, ctx.cwd);
			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}

			if (!existsSync(sessionPath)) {
				return errorResult(`Session file not found: ${sessionPath}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Querying session: ${sessionPath}` }],
				details: { status: "loading", sessionPath, question },
			});

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (error) {
				return errorResult(`Failed to load session: ${String(error)}`);
			}

			const branch = sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty (no messages)." }],
				};
			}

			const resolved = await resolveQueryModelAndAuth(ctx, branch);
			if (!resolved) {
				return errorResult("No usable model/auth available to analyze the session.");
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${question}`,
					},
				],
				timestamp: Date.now(),
			};

			try {
				const response = await complete(
					resolved.model,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: resolved.apiKey, headers: resolved.headers, signal },
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text" as const, text: "Session query cancelled." }],
					};
				}

				const answer = response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();

				return {
					content: [
						{
							type: "text" as const,
							text: `**Query:** ${question}\n**Session:** ${sessionPath}\n\n---\n\n${answer || "No answer generated."}`,
						},
					],
					details: {
						sessionPath,
						question,
						messageCount: messages.length,
					},
				};
			} catch (error) {
				return errorResult(`Session query failed: ${String(error)}`);
			}
		},
	});
}
