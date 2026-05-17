import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runQuestionnaire } from "./questionnaire.js";

const optionSchema = Type.Object({
	value: Type.String({ description: "Stable option value" }),
	label: Type.String({ description: "Human-readable option label" }),
	description: Type.Optional(Type.String({ description: "Optional extra context" })),
});

const questionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable answer id" })),
	question: Type.String({ description: "Question to ask the user" }),
	label: Type.Optional(Type.String({ description: "Short tab/heading label" })),
	options: Type.Optional(Type.Array(optionSchema)),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a custom freeform answer" })),
});

function formatAskUserResult(result: Awaited<ReturnType<typeof runQuestionnaire>>): string {
	if (result.cancelled) return "User cancelled the questionnaire.";
	if (result.answers.length === 0) return "No answers provided.";
	return result.answers.map((answer) => {
		const selected = answer.selected.map((item) => item.label.trim()).filter(Boolean);
		const custom = answer.custom.map((item) => item.trim()).filter(Boolean);
		const values = custom.length > 0 ? custom : selected;
		const response = values.length > 0 ? values.join(", ") : "(no answer)";
		return `Q: ${answer.question}\nA: ${response}`;
	}).join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Ask one or more structured clarification questions when a user decision or missing requirement blocks progress.",
		promptSnippet: "Use ask_user when a user decision or missing requirement blocks safe progress.",
		parameters: Type.Object({
			questions: Type.Array(questionSchema, { description: "Questions to ask" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runQuestionnaire(ctx, params.questions, "Question");
			return {
				content: [{ type: "text" as const, text: formatAskUserResult(result) }],
				details: result,
			};
		},
	});
}
