/**
 * Auto Continue Extension
 *
 * Toggle autonomous follow-up turns with /continue.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "auto-continue-state";
const CONTINUE_PROMPT =
	"Continue working autonomously on the current task. Take the next concrete steps, using tools as needed; do not merely restate progress or wait for confirmation unless a user decision is required.";

function endedWithError(messages: AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") {
			return message.stopReason === "error";
		}
	}
	return false;
}

export default function autoContinueExtension(pi: ExtensionAPI) {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("auto-continue", enabled ? "continue: on" : undefined);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		enabled = next;
		pi.appendEntry(STATE_TYPE, { enabled });
		updateStatus(ctx);
		ctx.ui.notify(`Auto-continue ${enabled ? "enabled" : "disabled"}`, "info");
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				enabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
			}
		}
		updateStatus(ctx);
	});

	pi.registerCommand("continue", {
		description: "Toggle automatic continuation (on|off)",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const matches = ["on", "off"]
				.filter((value) => value.startsWith(query))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument && argument !== "on" && argument !== "off") {
				ctx.ui.notify('Usage: /continue [on|off]', "error");
				return;
			}

			const next = argument ? argument === "on" : !enabled;
			if (next === enabled) {
				ctx.ui.notify(`Auto-continue already ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			setEnabled(next, ctx);
			if (enabled && ctx.isIdle()) {
				pi.sendUserMessage(CONTINUE_PROMPT);
			}
		},
	});

	pi.on("agent_end", (event, ctx) => {
		if (!enabled || ctx.hasPendingMessages() || endedWithError(event.messages)) {
			return;
		}
		pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
	});
}
