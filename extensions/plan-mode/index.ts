/**
 * Plan Mode Extension
 *
 * Read-only investigation followed by a single implementation handoff.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const CHOICE_EXECUTE = "Execute plan";
const CHOICE_STAY = "Stay in plan mode";
const CHOICE_EXIT = "Exit plan mode";

interface PlanModeState {
	enabled: boolean;
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

	async function executePlan(plan: string, ctx: ExtensionContext): Promise<void> {
		disablePlanMode(ctx, false);
		ctx.ui.notify("Plan approved. Starting implementation.", "info");
		pi.sendUserMessage(
			`Implement the approved plan below. Work through the complete plan naturally, make the requested changes, and run appropriate checks. Do not stop after an arbitrary individual step unless a user decision is required.\n\n${plan}`,
			{ deliverAs: "followUp" },
		);
	}

	pi.registerCommand("plan", {
		description: "Toggle read-only plan mode",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	for (const key of [Key.shift("tab"), Key.ctrlAlt("p")]) {
		pi.registerShortcut(key, {
			description: "Toggle plan mode",
			handler: async (ctx) => togglePlanMode(ctx),
		});
	}

	pi.on("before_agent_start", async (event) => {
		if (!enabled) {
			return;
		}

		// Reapply after presets or dynamically loaded tools change the active set.
		activateReadOnlyTools();
		return { systemPrompt: `${event.systemPrompt}${PLAN_INSTRUCTIONS}` };
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
			CHOICE_STAY,
			CHOICE_EXIT,
		]);

		if (choice === CHOICE_EXECUTE) {
			await executePlan(plan, ctx);
		} else if (choice === CHOICE_EXIT) {
			disablePlanMode(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const savedState = ctx.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom" && entry.customType === STATE_TYPE,
			)
			.pop()?.data as PlanModeState | undefined;

		enabled = pi.getFlag("plan") === true || savedState?.enabled === true;
		toolsBeforePlanMode = savedState?.toolsBeforePlanMode;
		updateStatus(ctx);
	});
}
