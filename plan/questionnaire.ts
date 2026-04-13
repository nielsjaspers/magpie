import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface QuestionnaireOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionnaireQuestion {
	id?: string;
	question: string;
	options?: QuestionnaireOption[];
	multiSelect?: boolean;
	allowCustom?: boolean;
}

export interface QuestionnaireAnswer {
	id: string;
	question: string;
	kind: "freeform" | "single" | "multi";
	selected: Array<{ value: string; label: string }>;
	custom: string[];
	cancelled?: boolean;
}

export async function runQuestionnaire(
	ctx: ExtensionContext,
	questions: QuestionnaireQuestion[],
	title?: string,
): Promise<{ answers: QuestionnaireAnswer[]; cancelled: boolean }> {
	const answers: QuestionnaireAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const id = q.id?.trim() || `q${i + 1}`;
		const options = q.options ?? [];
		const allowCustom = q.allowCustom !== false;
		if (options.length === 0) {
			const answer = await ctx.ui.input(title ?? `Question ${i + 1}`, q.question);
			if (answer === undefined) return { answers, cancelled: true };
			answers.push({ id, question: q.question, kind: "freeform", selected: [], custom: [answer.trim()] });
			continue;
		}
		if (q.multiSelect) {
			const optionsText = options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`).join("\n");
			const raw = await ctx.ui.input(title ?? `Question ${i + 1}`, `${q.question}\n\n${optionsText}\n\nEnter comma-separated numbers${allowCustom ? " and/or custom text" : ""}.`);
			if (raw === undefined) return { answers, cancelled: true };
			const selected: Array<{ value: string; label: string }> = [];
			const custom: string[] = [];
			for (const token of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
				if (/^\d+$/.test(token)) {
					const option = options[Number(token) - 1];
					if (option && !selected.some((entry) => entry.value === option.value)) selected.push({ value: option.value, label: option.label });
				} else if (allowCustom) {
					custom.push(token);
				}
			}
			answers.push({ id, question: q.question, kind: "multi", selected, custom });
			continue;
		}
		const choice = await ctx.ui.select(q.question, [...options.map((option) => option.label), ...(allowCustom ? ["✍️ Custom answer"] : [])]);
		if (!choice) return { answers, cancelled: true };
		if (choice.startsWith("✍️")) {
			const custom = await ctx.ui.input(title ?? `Question ${i + 1}`, q.question);
			if (custom === undefined) return { answers, cancelled: true };
			answers.push({ id, question: q.question, kind: "single", selected: [], custom: [custom.trim()] });
			continue;
		}
		const option = options.find((candidate) => candidate.label === choice);
		if (!option) return { answers, cancelled: true };
		answers.push({ id, question: q.question, kind: "single", selected: [{ value: option.value, label: option.label }], custom: [] });
	}
	return { answers, cancelled: false };
}
