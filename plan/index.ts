import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runQuestionnaire } from "./questionnaire.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Ask the user one or more clarification questions using the interactive questionnaire UI.",
		promptSnippet: "Ask the user a structured question when their input is needed to proceed.",
		promptGuidelines: ["ask_user: Use when a choice or missing detail materially changes the outcome."],
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			questions: Type.Array(Type.Object({
				id: Type.Optional(Type.String()),
				question: Type.String(),
				options: Type.Optional(Type.Array(Type.Object({
					value: Type.String(),
					label: Type.String(),
					description: Type.Optional(Type.String()),
				}))),
				multiSelect: Type.Optional(Type.Boolean()),
				allowCustom: Type.Optional(Type.Boolean()),
			}), { minItems: 1, maxItems: 6 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "No interactive UI available for user questions." }], details: {}, isError: true };
			const result = await runQuestionnaire(ctx, params.questions, params.title);
			if (result.cancelled) return { content: [{ type: "text", text: "User cancelled question flow." }], details: result };
			const summary = result.answers.map((answer, index) => `${index + 1}. ${answer.id}: ${[answer.selected.map((item) => `${item.label}(${item.value})`).join(", "), answer.custom.join(", ")].filter(Boolean).join(" | ") || "(empty)"}`).join("\n");
			return { content: [{ type: "text", text: `User answers:\n${summary}` }], details: result };
		},
	});
}
