/**
 * Protected Paths Extension
 *
 * Hard-blocks writes/edits to high-risk paths. Complements approval-mode.ts
 * (which prompts for sensitive paths). This is a last line of defense for
 * directories that should almost never be touched by an agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HARD_BLOCK = ["/proc/", "/sys/", "/dev/"];

const HARD_BLOCK_EXACT_SUFFIX: string[] = [];

export default function protectedPathsExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const filePath = String((event.input as { path?: string }).path || "");
		if (!filePath) return undefined;

		const normalized = filePath.replace(/\\/g, "/");

		const blocked =
			HARD_BLOCK.some((p) => normalized.includes(p.replace(/\\/g, "/"))) ||
			HARD_BLOCK_EXACT_SUFFIX.some((s) => normalized.endsWith(s));

		if (blocked) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${filePath}`, "warning");
			}
			return { block: true, reason: `Path "${filePath}" is protected` };
		}

		return undefined;
	});
}
