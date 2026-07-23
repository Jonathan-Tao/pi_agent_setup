/**
 * Plan Mode Extension
 *
 * Read-only investigation followed by a single implementation handoff.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	compact,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const STATE_TYPE = "plan-mode";
const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"question",
	"google_search",
	"pdf",
]);
const PLAN_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?Plan:(?:\*\*)?\s*$/im;
const PLAN_INSTRUCTIONS = `

[PLAN MODE]
Investigate the request without changing repository or system state. Use only the available read-only tools. Ask the user when a decision is required. When the investigation is complete, provide the implementation plan as numbered steps under an exact \`Plan:\` heading. Do not implement the plan.`;
const EXECUTION_INSTRUCTIONS = `

[PLAN EXECUTION]
Plan mode is inactive. Ignore earlier plan-mode instructions that prohibited implementation. Implement the approved plan with the active tools, make the requested changes, and run appropriate checks.`;
const EXECUTION_COMPACTION_INSTRUCTIONS = `Preserve the complete approved plan and all context needed to continue executing it. Clearly distinguish completed work from remaining plan steps; retain changes made, checks run and their results, relevant files and symbols, decisions, blockers, and unresolved questions. Explicitly instruct the continuing agent that plan mode is inactive and it must resume implementation from the first incomplete step rather than return to planning.`;

const CHOICE_EXECUTE = "Execute plan";
const CHOICE_EXECUTE_CLEAR = "Execute plan (clear planning context)";
const CHOICE_STAY = "Stay in plan mode";
const CHOICE_EXIT = "Exit plan mode";
const CLEAR_EXECUTION_COMMAND = "plan-execute-clear";

interface PlanModeState {
	enabled: boolean;
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let executing = false;
	let pendingClearPlan: string | undefined;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in read-only plan mode",
		type: "boolean",
		default: false,
	});

	function availableToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function persistState(): void {
		pi.appendEntry<PlanModeState>(STATE_TYPE, {
			enabled,
			executing,
			toolsBeforePlanMode,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATE_TYPE,
			enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
		);
	}

	function activateReadOnlyTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}

		const available = availableToolNames();
		pi.setActiveTools([...READ_ONLY_TOOLS].filter((name) => available.has(name)));
	}

	function restorePreviousTools(): void {
		if (toolsBeforePlanMode === undefined) {
			return;
		}

		const available = availableToolNames();
		pi.setActiveTools(toolsBeforePlanMode.filter((name) => available.has(name)));
		toolsBeforePlanMode = undefined;
	}

	function enablePlanMode(ctx: ExtensionContext): void {
		enabled = true;
		executing = false;
		activateReadOnlyTools();
		persistState();
		updateStatus(ctx);
		ctx.ui.notify("Plan mode enabled. Only mechanically read-only tools are available.", "info");
	}

	function disablePlanMode(ctx: ExtensionContext, notify = true): void {
		enabled = false;
		restorePreviousTools();
		persistState();
		updateStatus(ctx);
		if (notify) {
			ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (enabled) {
			disablePlanMode(ctx);
		} else {
			enablePlanMode(ctx);
		}
	}

	function executionPrompt(plan: string): string {
		return `Plan mode is now inactive. Implement the approved plan below. Work through the complete plan naturally, make the requested changes, and run appropriate checks. Do not stop after an arbitrary individual step unless a user decision is required.\n\n${plan}`;
	}

	async function executePlan(plan: string, ctx: ExtensionContext): Promise<void> {
		disablePlanMode(ctx, false);
		executing = true;
		persistState();
		ctx.ui.notify("Plan approved. Starting implementation.", "info");
		pi.sendUserMessage(executionPrompt(plan), { deliverAs: "followUp" });
	}

	async function executePlanWithClearContext(plan: string, ctx: ExtensionContext): Promise<void> {
		disablePlanMode(ctx, false);
		pendingClearPlan = plan;
		ctx.ui.notify("Plan approved. Starting implementation in a fresh session.", "info");
		pi.sendUserMessage(`/${CLEAR_EXECUTION_COMMAND}`, { deliverAs: "followUp" });
	}

	pi.registerCommand("plan", {
		description: "Toggle read-only plan mode",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand(CLEAR_EXECUTION_COMMAND, {
		description: "Execute the approved plan in a fresh session",
		handler: async (_args, ctx) => {
			const plan = pendingClearPlan;
			pendingClearPlan = undefined;
			if (!plan) {
				ctx.ui.notify("No approved plan is queued for execution.", "warning");
				return;
			}

			await ctx.waitForIdle();
			const result = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(STATE_TYPE, {
						enabled: false,
						executing: true,
					} satisfies PlanModeState);
				},
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(executionPrompt(plan));
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Fresh-session plan execution was cancelled.", "warning");
			}
		},
	});

	for (const key of [Key.shift("tab"), Key.ctrlAlt("p")]) {
		pi.registerShortcut(key, {
			description: "Toggle plan mode",
			handler: async (ctx) => togglePlanMode(ctx),
		});
	}

	pi.on("before_agent_start", async (event) => {
		if (enabled) {
			// Reapply after presets or dynamically loaded tools change the active set.
			activateReadOnlyTools();
			return { systemPrompt: `${event.systemPrompt}${PLAN_INSTRUCTIONS}` };
		}

		if (executing) {
			return { systemPrompt: `${event.systemPrompt}${EXECUTION_INSTRUCTIONS}` };
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!executing || !ctx.model) {
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			ctx.ui.notify(`Could not preserve plan context during compaction: ${auth.error}`, "warning");
			return;
		}

		const instructions = [event.customInstructions, EXECUTION_COMPACTION_INSTRUCTIONS]
			.filter((instruction): instruction is string => Boolean(instruction?.trim()))
			.join("\n\n");
		const compaction = await compact(
			event.preparation,
			ctx.model,
			auth.apiKey,
			auth.headers,
			instructions,
			event.signal,
			pi.getThinkingLevel(),
			undefined,
			auth.env,
		);
		return { compaction };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled || !ctx.hasUI) {
			return;
		}

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) {
			return;
		}

		const plan = getTextContent(lastAssistant).trim();
		if (!PLAN_HEADING.test(plan)) {
			return;
		}

		const choice = await ctx.ui.select("Plan ready — what next?", [
			CHOICE_EXECUTE,
			CHOICE_EXECUTE_CLEAR,
			CHOICE_STAY,
			CHOICE_EXIT,
		]);

		if (choice === CHOICE_EXECUTE) {
			await executePlan(plan, ctx);
		} else if (choice === CHOICE_EXECUTE_CLEAR) {
			await executePlanWithClearContext(plan, ctx);
		} else if (choice === CHOICE_EXIT) {
			disablePlanMode(ctx);
		}
	});

	pi.on("agent_settled", async () => {
		if (executing && !enabled) {
			executing = false;
			persistState();
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const savedState = ctx.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom" && entry.customType === STATE_TYPE,
			)
			.pop()?.data as PlanModeState | undefined;

		executing = savedState?.executing === true;
		enabled = !executing && (
			savedState?.enabled === true ||
			(event.reason === "startup" && pi.getFlag("plan") === true)
		);
		toolsBeforePlanMode = savedState?.toolsBeforePlanMode;
		if (enabled) {
			activateReadOnlyTools();
		}
		updateStatus(ctx);
	});
}
