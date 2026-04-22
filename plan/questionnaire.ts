import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
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
		const multiAnswers = new Map<string, Map<string, Answer>>();
		const multiCustomKey = "__custom__";

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

		function getMultiAnswerMap(questionId: string): Map<string, Answer> {
			let selected = multiAnswers.get(questionId);
			if (!selected) {
				selected = new Map<string, Answer>();
				multiAnswers.set(questionId, selected);
			}
			return selected;
		}

		function removeMultiIfEmpty(questionId: string) {
			if ((multiAnswers.get(questionId)?.size ?? 0) === 0) {
				multiAnswers.delete(questionId);
			}
		}

		function getQuestionAnswers(question: Question): Answer[] {
			if (!question.multiSelect) {
				const answer = answers.get(question.id);
				return answer ? [answer] : [];
			}
			const selected = multiAnswers.get(question.id);
			if (!selected) return [];
			return [...selected.values()].sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
		}

		function isQuestionAnswered(question: Question): boolean {
			if (!question.multiSelect) return answers.has(question.id);
			return (multiAnswers.get(question.id)?.size ?? 0) > 0;
		}

		function isOptionChecked(question: Question, option: RenderOption): boolean {
			if (!question.multiSelect) return false;
			const selected = multiAnswers.get(question.id);
			if (!selected) return false;
			if (option.isOther) return selected.has(multiCustomKey);
			return selected.has(option.value);
		}

		function submit(cancelled: boolean) {
			const questionnaireAnswers: QuestionnaireAnswer[] = questions.map((q) => {
				const selectedAnswers = getQuestionAnswers(q);
				return {
					id: q.id,
					question: q.prompt,
					kind: q.multiSelect ? "multi" : "single",
					selected: selectedAnswers.map((answer) => ({ value: answer.value, label: answer.label })),
					custom: selectedAnswers.filter((answer) => answer.wasCustom).map((answer) => answer.label),
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
			return questions.every((q) => isQuestionAnswered(q));
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

		function toggleMultiAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
			const selected = getMultiAnswerMap(questionId);
			const key = wasCustom ? multiCustomKey : value;
			if (selected.has(key)) {
				selected.delete(key);
			} else {
				selected.set(key, { id: questionId, value, label, wasCustom, index });
			}
			removeMultiIfEmpty(questionId);
		}

		function setMultiCustomAnswer(questionId: string, value: string) {
			const selected = getMultiAnswerMap(questionId);
			selected.set(multiCustomKey, {
				id: questionId,
				value,
				label: value,
				wasCustom: true,
				index: Number.MAX_SAFE_INTEGER,
			});
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			const inputQuestion = questions.find((question) => question.id === inputQuestionId);
			if (inputQuestion?.multiSelect) {
				setMultiCustomAnswer(inputQuestionId, trimmed);
				inputMode = false;
				inputQuestionId = null;
				editor.setText("");
				refresh();
				return;
			}
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
				optionIndex = Math.min(Math.max(0, opts.length - 1), optionIndex + 1);
				refresh();
				return;
			}

			if (q?.multiSelect && matchesKey(data, Key.space)) {
				const opt = opts[optionIndex];
				if (!opt) return;
				if (opt.isOther) {
					if (multiAnswers.get(q.id)?.has(multiCustomKey)) {
						multiAnswers.get(q.id)?.delete(multiCustomKey);
						removeMultiIfEmpty(q.id);
						refresh();
						return;
					}
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				toggleMultiAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.multiSelect) {
					if (isQuestionAnswered(q)) {
						advanceAfterAnswer();
					}
					return;
				}
				const opt = opts[optionIndex];
				if (!opt) return;
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
					const isAnswered = isQuestionAnswered(questions[i]);
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
					const checked = q ? isOptionChecked(q, opt) : false;
					const checkbox = q?.multiSelect ? `${checked ? "☑" : "☐"} ` : "";
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : checked ? "success" : "text";
					if (isOther && inputMode) {
						add(prefix + theme.fg("accent", `${checkbox}${i + 1}. ${opt.label} ✎`));
					} else {
						add(prefix + theme.fg(color, `${checkbox}${i + 1}. ${opt.label}`));
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
					const questionAnswers = getQuestionAnswers(question);
					if (questionAnswers.length > 0) {
						const summary = questionAnswers
							.map((answer) => `${answer.wasCustom ? "(wrote) " : ""}${answer.label}`)
							.join(", ");
						add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", summary)}`);
					}
				}
				lines.push("");
				if (allAnswered()) {
					add(theme.fg("success", " Press Enter to submit"));
				} else {
					const missing = questions
						.filter((question) => !isQuestionAnswered(question))
						.map((question) => question.label)
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
				const nav = isMulti ? " Tab/←→ navigate • ↑↓ select" : " ↑↓ navigate";
				const action = currentTab === questions.length
					? " • Enter submit • Esc cancel"
					: q?.multiSelect
						? " • Space toggle • Enter confirm • Esc cancel"
						: " • Enter select • Esc cancel";
				add(theme.fg("dim", `${nav}${action}`));
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
