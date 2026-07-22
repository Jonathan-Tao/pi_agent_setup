/**
 * Plan Mode Extension
 *
 * Read-only investigation mode for implementation planning.
 * When enabled, direct write and elevation tools are disabled.
 *
 * Features:
 * - /plan command, Shift+Tab, or Ctrl+Alt+P to toggle
 * - Bash permits investigation commands while blocking known mutations
 * - Extracts numbered plan steps from "Plan:" sections
 * - On plan ready: execute / execute+clear context / refine / stay / exit
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	extractPlanSection,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	shortStepLabel,
	type TodoItem,
} from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "subagent", "question", "google_search", "pdf"];
const NORMAL_MODE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"subagent",
	"google_search",
	"pdf",
	"question",
	"sudo",
];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "sudo"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	/** Drop planning exploration from LLM context while executing. */
	clearPlanningContext?: boolean;
	/** Full Plan: section text captured at approval time. */
	planSourceText?: string;
	/** Marker string embedded in the execute message for context boundary detection. */
	executionMarker?: string;
	toolsBeforePlanMode?: string[];
}

const EXEC_MARKER_PREFIX = "[[PI_PLAN_EXEC:";

const CHOICE_EXECUTE = "Execute plan";
const CHOICE_EXECUTE_CLEAR = "Execute plan (clear planning context)";
const CHOICE_STAY = "Stay in plan mode";
const CHOICE_REFINE = "Refine the plan";
const CHOICE_EXIT = "Exit plan mode";

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function formatPlanList(items: TodoItem[], opts?: { checkboxes?: boolean }): string {
	return items
		.map((t) => {
			if (opts?.checkboxes) {
				return `${t.step}. ${t.completed ? "☑" : "☐"} ${t.text}`;
			}
			return `${t.step}. ${t.text}`;
		})
		.join("\n");
}

function isCustomMessage(
	m: AgentMessage,
): m is AgentMessage & { customType?: string; content?: unknown } {
	return typeof m === "object" && m !== null && "customType" in m;
}

const SUBAGENT_PLAN_GUARD =
	"PLAN MODE: Perform read-only reconnaissance only. Do not edit files, change repository state, install packages, or run destructive commands.\n\n";

function guardSubagentTasks(input: Record<string, unknown>): void {
	if (typeof input.task === "string" && !input.task.startsWith(SUBAGENT_PLAN_GUARD)) {
		input.task = `${SUBAGENT_PLAN_GUARD}${input.task}`;
	}
	for (const key of ["tasks", "chain"] as const) {
		const entries = input[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) continue;
			const task = (entry as { task?: unknown }).task;
			if (typeof task === "string" && !task.startsWith(SUBAGENT_PLAN_GUARD)) {
				(entry as { task: string }).task = `${SUBAGENT_PLAN_GUARD}${task}`;
			}
		}
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	/** When true, context hook strips pre-execution exploration. */
	let clearPlanningContext = false;
	/** Full Plan: body captured when the plan is approved. */
	let planSourceText = "";
	/** Unique marker embedded in the execute message for context slicing. */
	let executionMarker = "";
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only investigation)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list (short labels only)
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				const label = shortStepLabel(item.text);
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(label))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${label}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			clearPlanningContext,
			planSourceText,
			executionMarker,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function exitPlanMode(ctx: ExtensionContext, notify = true): void {
		planModeEnabled = false;
		executionMode = false;
		clearPlanningContext = false;
		planSourceText = "";
		executionMarker = "";
		todoItems = [];
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();
		if (notify) ctx.ui.notify("Plan mode disabled. Full access restored.");
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled || executionMode) {
			exitPlanMode(ctx);
			return;
		}
		planModeEnabled = true;
		executionMode = false;
		clearPlanningContext = false;
		planSourceText = "";
		executionMarker = "";
		todoItems = [];
		enablePlanModeTools();
		ctx.ui.notify("Plan mode enabled. Writes blocked; investigation tools available.");
		updateStatus(ctx);
		persistState();
	}

	function buildPlanBriefing(): string {
		const remaining = todoItems.filter((t) => !t.completed);
		const done = todoItems.filter((t) => t.completed);
		const next = remaining[0];
		const lines = [
			"[PLAN EXECUTION]",
			"",
			"Rules:",
			"- The approved plan is BELOW. Do NOT search the repo for the plan/task list.",
			"- Do NOT restart discovery. Continue from the next incomplete step.",
			"- After finishing step n, include [DONE:n] in your reply.",
			"- Work the codebase directly (read/edit/bash) for the current step only.",
			"",
			"Approved plan:",
			planSourceText
				? `Plan:\n${planSourceText}`
				: formatPlanList(todoItems, { checkboxes: true }),
			"",
		];
		if (done.length > 0) {
			lines.push(`Completed steps: ${done.map((t) => t.step).join(", ")}`, "");
		}
		if (next) {
			lines.push(`Next step (${next.step}): ${next.text}`, "");
		}
		if (remaining.length > 0) {
			lines.push("Remaining:", formatPlanList(remaining), "");
		}
		return lines.join("\n");
	}

	function messageText(m: AgentMessage): string {
		if (isCustomMessage(m) && typeof m.content === "string") return m.content;
		if (isAssistantMessage(m)) return getTextContent(m);
		const any = m as { content?: unknown; role?: string };
		if (typeof any.content === "string") return any.content;
		if (Array.isArray(any.content)) {
			return any.content
				.map((c) => (c && typeof c === "object" && "text" in c ? String((c as TextContent).text ?? "") : ""))
				.join("\n");
		}
		return "";
	}

	/** Index of the execution boundary message, or -1. */
	function findExecutionBoundary(messages: AgentMessage[]): number {
		// Prefer earliest match of our marker so we keep all post-execute work.
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (isCustomMessage(m) && m.customType === "plan-mode-execute") return i;
			const text = messageText(m);
			if (executionMarker && text.includes(executionMarker)) return i;
			if (text.includes("[PLAN EXECUTION]") && text.includes("Approved plan:")) return i;
		}
		return -1;
	}

	async function startExecution(
		ctx: ExtensionContext,
		opts: { clearContext: boolean },
	): Promise<void> {
		const firstTodoItem = todoItems[0];
		if (!firstTodoItem) return;

		planModeEnabled = false;
		executionMode = true;
		clearPlanningContext = opts.clearContext;
		executionMarker = `${EXEC_MARKER_PREFIX}${Date.now()}]]`;
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();

		const todoListText = formatPlanList(todoItems, { checkboxes: true });
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const briefing = buildPlanBriefing();
		const execMessage = `${executionMarker}
${briefing}
Start implementing step ${firstTodoItem.step} now.`;

		pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: execMessage, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		if (opts.clearContext) {
			ctx.ui.notify("Executing with cleared planning context", "info");
		} else {
			ctx.ui.notify("Executing plan", "info");
		}
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only investigation)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	for (const key of [Key.shift("tab"), Key.ctrlAlt("p")]) {
		pi.registerShortcut(key, {
			description: "Toggle plan mode",
			handler: async (ctx) => togglePlanMode(ctx),
		});
	}

	// Keep delegated reconnaissance read-only and block known shell mutations.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "subagent") {
			guardSubagentTasks(event.input as Record<string, unknown>);
			return;
		}
		if (event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked because it appears to mutate state. Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Prune / reshape messages sent to the LLM
	pi.on("context", async (event) => {
		const stripPlanNoise = (messages: AgentMessage[]): AgentMessage[] =>
			messages.filter((m) => {
				if (isCustomMessage(m) && m.customType === "plan-mode-context") return false;
				// Drop per-turn execution nudges; briefing already carries state
				if (isCustomMessage(m) && m.customType === "plan-execution-context") return false;
				return true;
			});

		/*
		 * Clear-context execution must NEVER drop assistant/tool history after the
		 * execute boundary. Doing so causes amnesia loops (same greps every call).
		 * Fail open: if the boundary can't be found, keep full history + briefing.
		 */
		if (executionMode && clearPlanningContext && todoItems.length > 0) {
			const briefing: AgentMessage = {
				role: "user",
				content: buildPlanBriefing(),
				timestamp: Date.now(),
			} as AgentMessage;

			const boundary = findExecutionBoundary(event.messages);
			const base =
				boundary >= 0 ? event.messages.slice(boundary) : event.messages;
			const cleaned = stripPlanNoise(base);

			// Avoid duplicating an identical execute/briefing user message at head
			const rest = cleaned.filter((m, idx) => {
				if (idx === 0 && isCustomMessage(m) && m.customType === "plan-mode-execute") {
					return false; // replaced by fresh briefing
				}
				const text = messageText(m);
				if (executionMarker && text.includes(executionMarker) && idx === 0) return false;
				return true;
			});

			return { messages: [briefing, ...rest] };
		}

		if (planModeEnabled) return;

		// Not in plan mode: strip stale plan-mode prompts
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === "plan-execution-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE] Read-only investigation. Do not edit files or change system/repository state. Use read-only shell and git commands, searches, documentation, questions, and read-only subagent reconnaissance as needed to gather enough evidence for an implementation plan. Output numbered steps under:

Plan:
1. ...
2. ...`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			// Light per-turn nudge only (full plan lives in briefing / execute msg).
			// Skipped from context when clearPlanningContext rebuilds the briefing.
			const next = todoItems.find((t) => !t.completed);
			if (!next) return;
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN] Next: ${next.step}. ${next.text}
Mark finished steps with [DONE:n]. Do not re-discover the plan.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				clearPlanningContext = false;
				planSourceText = "";
				executionMarker = "";
				todoItems = [];
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos + full plan body from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const assistantText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(assistantText);
			if (extracted.length > 0) {
				todoItems = extracted;
				const section = extractPlanSection(assistantText);
				if (section) planSourceText = section;
			}
		}

		if (todoItems.length === 0) return;
		persistState();

		// Show plan steps and prompt for next action
		const todoListText = formatPlanList(todoItems, { checkboxes: true });
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan ready — what next?", [
			CHOICE_EXECUTE,
			CHOICE_EXECUTE_CLEAR,
			CHOICE_STAY,
			CHOICE_REFINE,
			CHOICE_EXIT,
		]);

		if (!choice || choice === CHOICE_STAY) {
			// Keep plan mode; surface the extracted steps in the transcript
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			return;
		}

		if (choice === CHOICE_EXECUTE || choice === CHOICE_EXECUTE_CLEAR) {
			await startExecution(ctx, { clearContext: choice === CHOICE_EXECUTE_CLEAR });
			return;
		}

		if (choice === CHOICE_REFINE) {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			} else {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			}
			return;
		}

		if (choice === CHOICE_EXIT) {
			exitPlanMode(ctx);
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			clearPlanningContext = planModeEntry.data.clearPlanningContext ?? clearPlanningContext;
			planSourceText = planModeEntry.data.planSourceText ?? planSourceText;
			executionMarker = planModeEntry.data.executionMarker ?? executionMarker;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
