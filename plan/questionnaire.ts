import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface QuestionnaireOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionnaireOption & { isOther?: boolean };

export interface QuestionnaireQuestion {
	id?: string;
	question: string;
	label?: string;
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

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionnaireOption[];
	allowOther: boolean;
	multiSelect: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: QuestionnaireAnswer[];
	cancelled: boolean;
}

export async function runQuestionnaire(
	ctx: ExtensionContext,
	rawQuestions: QuestionnaireQuestion[],
	_title?: string,
): Promise<{ answers: QuestionnaireAnswer[]; cancelled: boolean }> {
	if (!ctx.hasUI) {
		return { answers: [], cancelled: true };
	}

	const questions: Question[] = rawQuestions.map((q, i) => ({
		id: q.id?.trim() || `q${i + 1}`,
		label: q.label || `Q${i + 1}`,
		prompt: q.question,
		options: q.options ?? [],
		allowOther: q.allowCustom !== false,
		multiSelect: q.multiSelect ?? false,
	}));

	if (questions.length === 0) {
		return { answers: [], cancelled: true };
	}

	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // questions + Submit

	const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			const questionnaireAnswers: QuestionnaireAnswer[] = questions.map((q) => {
				const answer = answers.get(q.id);
				return {
					id: q.id,
					question: q.prompt,
					kind: q.multiSelect ? "multi" : "single",
					selected: answer ? [{ value: answer.value, label: answer.label }] : [],
					custom: answer?.wasCustom ? [answer.label] : [],
					cancelled,
				};
			});
			done({ questions, answers: questionnaireAnswers, cancelled });
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function currentOptions(): RenderOption[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: RenderOption[] = [...q.options];
			if (q.allowOther) {
				opts.push({ value: "__other__", label: "Type something.", isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			saveAnswer(inputQuestionId, trimmed, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = currentOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				const opt = opts[optionIndex];
				if (opt.isOther) {
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
				advanceAfterAnswer();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const q = currentQuestion();
			const opts = currentOptions();

			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));

			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const lbl = questions[i].label;
					const box = isAnswered ? "■" : "□";
					const color = isAnswered ? "success" : "muted";
					const text = ` ${box} ${lbl} `;
					const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const canSubmit = allAnswered();
				const isSubmitTab = currentTab === questions.length;
				const submitText = " ✓ Submit ";
				const submitStyled = isSubmitTab
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(canSubmit ? "success" : "dim", submitText);
				tabs.push(`${submitStyled} →`);
				add(` ${tabs.join("")}`);
				lines.push("");
			}

			function renderOptions() {
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const isOther = opt.isOther === true;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					if (isOther && inputMode) {
						add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
					} else {
						add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
					}
					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}
			}

			if (inputMode && q) {
				add(theme.fg("text", ` ${q.prompt}`));
				lines.push("");
				renderOptions();
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(width - 2)) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						const prefix = answer.wasCustom ? "(wrote) " : "";
						add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
					}
				}
				lines.push("");
				if (allAnswered()) {
					add(theme.fg("success", " Press Enter to submit"));
				} else {
					const missing = questions
						.filter((q) => !answers.has(q.id))
						.map((q) => q.label)
						.join(", ");
					add(theme.fg("warning", ` Unanswered: ${missing}`));
				}
			} else if (q) {
				add(theme.fg("text", ` ${q.prompt}`));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
					: " ↑↓ navigate • Enter select • Esc cancel";
				add(theme.fg("dim", help));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	if (result.cancelled) {
		return { answers: [], cancelled: true };
	}

	return {
		answers: result.answers,
		cancelled: false,
	};
}
