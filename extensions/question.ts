/**
 * Question Tool
 *
 * Lets the model ask you a question mid-turn:
 * - Multiple choice (optional descriptions)
 * - Free-text via "Type something…"
 * - Open-ended only (no options) → text editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass [] for a free-text answer.",
		}),
	),
});

function editorTheme(theme: {
	fg: (name: string, text: string) => string;
}): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

export default function questionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user a question and wait for their answer. Use when you need a decision, preference, clarification, or any other user input before continuing.",
		promptSnippet: "Ask the user a question (multiple choice or free text)",
		promptGuidelines: [
			"Use question instead of guessing when you need a decision or clarification.",
		],
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = params.options ?? [];
			const simpleOptions = options.map((o) => o.label);

			if (ctx.mode !== "tui") {
				if (!ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: "Error: UI not available (running in non-interactive mode)",
							},
						],
						details: {
							question: params.question,
							options: simpleOptions,
							answer: null,
						} satisfies QuestionDetails,
						isError: true,
					};
				}
				// RPC / limited UI: fall back to select or input
				if (options.length > 0) {
					const labels = [...options.map((o) => o.label), "Other…"];
					const choice = await ctx.ui.select(params.question, labels);
					if (!choice) {
						return {
							content: [{ type: "text", text: "User cancelled the selection" }],
							details: {
								question: params.question,
								options: simpleOptions,
								answer: null,
							} satisfies QuestionDetails,
						};
					}
					if (choice === "Other…") {
						const typed = await ctx.ui.input(params.question, "");
						if (!typed) {
							return {
								content: [{ type: "text", text: "User cancelled the selection" }],
								details: {
									question: params.question,
									options: simpleOptions,
									answer: null,
								} satisfies QuestionDetails,
							};
						}
						return {
							content: [{ type: "text", text: `User wrote: ${typed}` }],
							details: {
								question: params.question,
								options: simpleOptions,
								answer: typed,
								wasCustom: true,
							} satisfies QuestionDetails,
						};
					}
					return {
						content: [{ type: "text", text: `User selected: ${choice}` }],
						details: {
							question: params.question,
							options: simpleOptions,
							answer: choice,
							wasCustom: false,
						} satisfies QuestionDetails,
					};
				}
				const typed = await ctx.ui.input(params.question, "");
				if (!typed) {
					return {
						content: [{ type: "text", text: "User cancelled the selection" }],
						details: {
							question: params.question,
							options: [],
							answer: null,
						} satisfies QuestionDetails,
					};
				}
				return {
					content: [{ type: "text", text: `User wrote: ${typed}` }],
					details: {
						question: params.question,
						options: [],
						answer: typed,
						wasCustom: true,
					} satisfies QuestionDetails,
				};
			}

			// Open-ended free-text question
			if (options.length === 0) {
				const answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					let cachedLines: string[] | undefined;
					const edTheme = editorTheme(theme);
					const editor = new Editor(tui, edTheme);
					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) done(trimmed);
					};

					const refresh = () => {
						cachedLines = undefined;
						tui.requestRender();
					};

					return {
						render(width: number) {
							if (cachedLines) return cachedLines;
							const renderWidth = Math.max(1, width);
							const lines: string[] = [];
							const addWrapped = (text: string) => {
								lines.push(...wrapTextWithAnsi(text, renderWidth));
							};
							lines.push(theme.fg("accent", "─".repeat(renderWidth)));
							addWrapped(theme.fg("text", params.question));
							lines.push("");
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							addWrapped(theme.fg("dim", "Enter to submit · Esc to cancel"));
							lines.push(theme.fg("accent", "─".repeat(renderWidth)));
							cachedLines = lines;
							return lines;
						},
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput(data: string) {
							if (matchesKey(data, Key.escape)) {
								done(null);
								return;
							}
							editor.handleInput(data);
							refresh();
						},
					};
				});

				if (!answer) {
					return {
						content: [{ type: "text", text: "User cancelled the selection" }],
						details: {
							question: params.question,
							options: [],
							answer: null,
						} satisfies QuestionDetails,
					};
				}
				return {
					content: [{ type: "text", text: `User wrote: ${answer}` }],
					details: {
						question: params.question,
						options: [],
						answer,
						wasCustom: true,
					} satisfies QuestionDetails,
				};
			}

			// Multiple choice + "Type something."
			const allOptions: DisplayOption[] = [
				...options,
				{ label: "Type something.", isOther: true },
			];

			const result = await ctx.ui.custom<{
				answer: string;
				wasCustom: boolean;
				index?: number;
			} | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;

				const edTheme = editorTheme(theme);
				const editor = new Editor(tui, edTheme);

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						done({ answer: trimmed, wasCustom: true });
					} else {
						editMode = false;
						editor.setText("");
						refresh();
					}
				};

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Number keys 1-9 jump/select
					if (data.length === 1 && data >= "1" && data <= "9") {
						const idx = Number(data) - 1;
						if (idx < allOptions.length) {
							optionIndex = idx;
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({
									answer: selected.label,
									wasCustom: false,
									index: optionIndex + 1,
								});
							}
						}
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const selected = allOptions[optionIndex];
						if (selected.isOther) {
							editMode = true;
							refresh();
						} else {
							done({
								answer: selected.label,
								wasCustom: false,
								index: optionIndex + 1,
							});
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					addWrappedWithPrefix(" ", theme.fg("text", params.question));
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const opt = allOptions[i];
						const selected = i === optionIndex;
						const isOther = opt.isOther === true;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
						const color = selected || (isOther && editMode) ? "accent" : "text";

						addWrappedWithPrefix(prefix, theme.fg(color, label));

						if (opt.description) {
							addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
						}
					}

					if (editMode) {
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
					}

					lines.push("");
					if (editMode) {
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit · Esc to go back"));
					} else {
						addWrappedWithPrefix(
							" ",
							theme.fg("dim", "↑↓ navigate · 1-9 select · Enter · Esc cancel"),
						);
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

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

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: null,
					} satisfies QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} satisfies QuestionDetails,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `User selected: ${result.index}. ${result.answer}`,
					},
				],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} satisfies QuestionDetails,
			};
		},

		renderCall(args, theme) {
			const q = typeof args.question === "string" ? args.question : "";
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", q);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			} else {
				text += `\n${theme.fg("dim", "  (free text)")}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "(wrote) ") +
						theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
