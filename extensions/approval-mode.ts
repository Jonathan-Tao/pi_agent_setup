/**
 * Approval Mode Extension
 *
 * Modes:
 * - ask  : confirm every write/edit and every bash command
 * - auto : trust agent work; only block commands that are directly destructive
 *
 * There is intentionally NO bypass for catastrophic system-damage patterns.
 *
 * Commands:
 *   /approval          interactive selector
 *   /approval ask|auto set mode directly
 *   Ctrl+Shift+A       cycle modes
 *
 * CLI:
 *   pi --approval auto
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type ApprovalMode = "ask" | "auto";

interface ApprovalState {
	mode: ApprovalMode;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Non-mutating helper tools — always allowed */
const SAFE_TOOLS = new Set([
	"google_search",
	"pdf",
	"question",
	"questionnaire",
	"sudo",
]);

/** Always hard-blocked — never executable. */
const HARD_BLOCK_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive).*(\s\/\s|\s\/$|\s~\/|\s\$HOME\b)/i,
	/\bmkfs(\.|$|\s)/i,
	/\bdd\s+.*\bof=\/dev\//i,
	/:\(\)\s*\{\s*:\|:&\s*\};?/i,
	/\bchmod\s+(-R\s+)?777\s+\/\b/i,
	/\b(shutdown|reboot|poweroff|halt)\b/i,
	/\bsystemctl\s+(poweroff|reboot|halt)\b/i,
	/\buserdel\b|\bdeluser\b/i,
];

/**
 * Auto mode still prompts for these. Keep this list tight — everyday dev
 * commands (curl, git status, docker ps, journalctl, python -c, …) should pass.
 * sudo is handled by the sudo extension (its own approve + password prompt).
 */
const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	// Destructive filesystem
	/\brm\s+(-[a-zA-Z]*r|--recursive)/i,
	/\b(mkfs|fdisk|parted|wipefs)\b/i,
	/\bdd\b.*\bof=/i,
	// Remote code execution / pipe-to-shell
	/\b(curl|wget|fetch)\b[^|\n]*\|\s*(ba)?sh\b/i,
	// Irreversible git
	/\bgit\s+push\s+[^\n]*\s(-f|--force)\b/i,
	/\bgit\s+push\s+(-f|--force)\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-zA-Z]*f/i,
	// Publish
	/\b(npm|pnpm|yarn|bun)\s+(-g\s+)?(publish|unpublish)\b/i,
	// Package manager mutations (queries like -Q/-Ss stay auto)
	/\b(pacman|paru|yay)\s+[^\n]*--(?:noconfirm)\b/i,
	/\b(pacman|paru|yay)\s+(-[a-zA-Z]*S[a-zA-Z]*|[^\s]*-S)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b/i,
	/\bdnf\s+(install|remove|erase|upgrade|update)\b/i,
	/\bbrew\s+(install|uninstall|reinstall|upgrade)\b/i,
	// Service / firewall changes
	/\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask|daemon-reload)\b/i,
	/\b(iptables|nft|ufw)\b/i,
	// Containers: only the scary bits
	/\b(docker|podman)\s+system\s+prune\b/i,
	/\b(docker|podman)\s+run\b[^\n]*--privileged\b/i,
	/\b(docker|podman)\s+(rmi|volume\s+rm|image\s+rm)\b/i,
	// System file writes
	/>\s*\/etc\//i,
	/\btee\s+\/etc\//i,
	/\bchmod\s+(-R\s+)?777\b/i,
	/\bcrontab\s+-[er]\b/i,
	// Alternate elevation (sudo has its own extension)
	/\bdoas\b/i,
];

/** Paths that always need confirmation for write/edit (never auto). */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.env$/i,
	/(^|\/)\.env\.[^/]+$/i,
	/(^|\/)credentials\./i,
	/(^|\/)secrets?\./i,
	/(^|\/)\.ssh(\/|$)/i,
	/(^|\/)\.gnupg(\/|$)/i,
	/(^|\/)\.aws(\/|$)/i,
	/(^|\/)\.config\/(gh|git|op|rclone)\//i,
	/(^|\/)id_rsa/i,
	/(^|\/)id_ed25519/i,
	/\.pem$/i,
	/\.key$/i,
	/(^|\/)auth\.json$/i,
	/(^|\/)\.netrc$/i,
	/(^|\/)known_hosts$/i,
	/(^|\/)shadow$/i,
	/(^|\/)sudoers/i,
];

const HARD_BLOCK_PATH_PATTERNS: RegExp[] = [];

function isHardBlockedCommand(command: string): boolean {
	return HARD_BLOCK_PATTERNS.some((p) => p.test(command));
}

function isDangerousCommand(command: string): boolean {
	return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
}

function isSensitivePath(filePath: string): boolean {
	return SENSITIVE_PATH_PATTERNS.some((p) => p.test(filePath));
}

function isHardBlockedPath(filePath: string): boolean {
	return HARD_BLOCK_PATH_PATTERNS.some((p) => p.test(filePath));
}

function isInsideCwd(filePath: string, cwd: string): boolean {
	const resolved = path.resolve(cwd, filePath);
	const root = path.resolve(cwd);
	return resolved === root || resolved.startsWith(root + path.sep);
}

function modeLabel(mode: ApprovalMode): string {
	return mode === "auto" ? "auto" : "ask";
}

function modeStatusText(mode: ApprovalMode, theme: ExtensionContext["ui"]["theme"]): string {
	if (mode === "auto") return theme.fg("success", "✓ auto");
	return theme.fg("warning", "? ask");
}

export default function approvalModeExtension(pi: ExtensionAPI) {
	let mode: ApprovalMode = "auto";

	pi.registerFlag("approval", {
		description: "Approval mode: ask | auto (default auto; never full YOLO)",
		type: "string",
	});

	function persist() {
		pi.appendEntry<ApprovalState>("approval-mode", { mode });
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("approval-mode", modeStatusText(mode, ctx.ui.theme));
	}

	function setMode(next: ApprovalMode, ctx?: ExtensionContext) {
		mode = next;
		persist();
		if (ctx) {
			updateStatus(ctx);
			ctx.ui.notify(`Approval mode: ${modeLabel(mode)}`, "info");
		}
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		let found: ApprovalMode | undefined;
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === "approval-mode") {
				const data = entry.data as ApprovalState | undefined;
				if (data?.mode === "ask" || data?.mode === "auto") found = data.mode;
			}
		}
		if (found) {
			mode = found;
		} else {
			const flag = pi.getFlag("approval");
			if (flag === "ask" || flag === "auto") mode = flag;
		}
		updateStatus(ctx);
	}

	async function confirm(ctx: ExtensionContext, title: string, detail: string): Promise<boolean> {
		if (!ctx.hasUI) return false;
		const choice = await ctx.ui.select(`${title}\n\n${detail}\n\nAllow?`, ["Yes", "No"]);
		return choice === "Yes";
	}

	pi.registerCommand("approval", {
		description: "Set approval mode (ask|auto). No full YOLO.",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "ask" || arg === "auto") {
				setMode(arg, ctx);
				return;
			}
			if (arg) {
				ctx.ui.notify("Usage: /approval [ask|auto]", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Current approval mode: ${mode}`, "info");
				return;
			}
			const choice = await ctx.ui.select(
				`Approval mode (current: ${modeLabel(mode)})\n\n` +
					"ask  = confirm writes + bash\n" +
					"auto = allow normal work; block only catastrophic system damage\n" +
					"(full unrestricted YOLO is intentionally not available)",
				["auto", "ask", "Cancel"],
			);
			if (choice === "auto" || choice === "ask") setMode(choice, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Cycle approval mode (ask ↔ auto)",
		handler: async (ctx) => {
			setMode(mode === "auto" ? "ask" : "auto", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;

		if (READ_TOOLS.has(tool) || SAFE_TOOLS.has(tool)) return undefined;

		// Subagents: auto mode may spawn freely; ask mode confirms
		if (tool === "subagent") {
			if (mode === "auto") return undefined;
			const summary = JSON.stringify(event.input).slice(0, 500);
			const ok = await confirm(ctx, "⚠️ Launch subagent?", summary);
			if (!ok) return { block: true, reason: "Subagent launch blocked by user" };
			return undefined;
		}

		if (tool === "write" || tool === "edit") {
			const filePath = String((event.input as { path?: string }).path || "");
			if (!filePath) return { block: true, reason: "Missing path" };

			if (isHardBlockedPath(filePath)) {
				if (ctx.hasUI) ctx.ui.notify(`Hard-blocked write: ${filePath}`, "error");
				return { block: true, reason: `Path is hard-blocked: ${filePath}` };
			}

			// Auto means auto: ordinary writes are allowed regardless of workspace or
			// sensitivity. Catastrophic paths remain covered by protected-paths.ts.
			if (mode === "auto") return undefined;

			const sensitive = isSensitivePath(filePath);
			const outside = !isInsideCwd(filePath, ctx.cwd);

			const reasons: string[] = [];
			if (mode === "ask") reasons.push("approval mode is ask");
			if (sensitive) reasons.push("sensitive path");
			if (outside) reasons.push("outside workspace");

			const ok = await confirm(
				ctx,
				`⚠️ ${tool} requires approval`,
				`${filePath}\n(${reasons.join(", ") || "confirmation required"})`,
			);
			if (!ok) return { block: true, reason: `${tool} blocked by approval gate` };
			return undefined;
		}

		if (tool === "bash") {
			const command = String((event.input as { command?: string }).command || "");

			if (isHardBlockedCommand(command)) {
				if (ctx.hasUI) {
					ctx.ui.notify("Hard-blocked dangerous command (cannot be approved)", "error");
				}
				return {
					block: true,
					reason: "Command matches a hard-blocked destructive pattern",
				};
			}

			// In auto mode, only the catastrophic hard-block list above intervenes.
			if (mode === "auto") return undefined;

			const dangerous = isDangerousCommand(command);
			const title = dangerous ? "⚠️ Dangerous command" : "⚠️ Bash requires approval";
			const ok = await confirm(ctx, title, `$ ${command}`);
			if (!ok) return { block: true, reason: "Command blocked by approval gate" };
			return undefined;
		}

		// Unknown custom tools: auto allows; ask confirms
		if (mode === "ask") {
			const ok = await confirm(
				ctx,
				`⚠️ Tool requires approval: ${tool}`,
				JSON.stringify(event.input).slice(0, 400),
			);
			if (!ok) return { block: true, reason: `Tool ${tool} blocked by approval gate` };
		}

		return undefined;
	});
}
