import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./subagent/agents.ts";

const STATE_TYPE = "auto-continue-state";
const REVIEW_TYPE = "auto-continue-review";
const MAX_AUTONOMOUS_CONTINUATIONS = 12;
const MAX_TRANSCRIPT_CHARS = 80_000;
const CONTINUE_PROMPT =
	"Continue working autonomously on the current task. Take the next concrete steps, using tools as needed; do not merely restate progress or wait for confirmation unless a user decision is required.";

interface GoalReview {
	decision: "complete" | "continue" | "wait";
	reason: string;
	next?: string;
}

function endedWithError(messages: AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message.stopReason === "error";
	}
	return false;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: unknown; text?: unknown };
			if (value.type === "text" && typeof value.text === "string") return value.text;
			if (value.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function sessionTranscript(ctx: ExtensionContext): string {
	const sections: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		const text = textContent(message.content).trim();
		if (!text) continue;

		if (message.role === "user") {
			if (text === CONTINUE_PROMPT || text.startsWith("Independent goal check:")) continue;
			sections.push(`USER:\n${text}`);
		} else if (message.role === "assistant") {
			sections.push(`ASSISTANT:\n${text}`);
		} else if (message.role === "toolResult") {
			sections.push(`TOOL ${message.toolName}:\n${text.slice(0, 4_000)}`);
		}
	}

	const transcript = sections.join("\n\n---\n\n");
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
	const headLength = 20_000;
	const tailLength = MAX_TRANSCRIPT_CHARS - headLength;
	return `${transcript.slice(0, headLength)}\n\n--- earlier details omitted ---\n\n${transcript.slice(-tailLength)}`;
}

function finalAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = textContent(message.content).trim();
		if (text) return text;
	}
	return "";
}

export function parseGoalReview(output: string): GoalReview {
	const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
	let value: unknown;
	try {
		value = JSON.parse(candidate);
	} catch {
		throw new Error("Goal reviewer returned invalid JSON.");
	}
	if (!value || typeof value !== "object") throw new Error("Goal reviewer returned no decision.");
	const review = value as { decision?: unknown; reason?: unknown; next?: unknown };
	if (review.decision !== "complete" && review.decision !== "continue" && review.decision !== "wait") {
		throw new Error("Goal reviewer returned an unknown decision.");
	}
	if (typeof review.reason !== "string" || !review.reason.trim()) {
		throw new Error("Goal reviewer omitted its reason.");
	}
	return {
		decision: review.decision,
		reason: review.reason.trim(),
		next: typeof review.next === "string" && review.next.trim() ? review.next.trim() : undefined,
	};
}

function getPiInvocation(args: string[]) {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export default function autoContinueExtension(pi: ExtensionAPI) {
	let enabled = false;
	let checking = false;
	let continuations = 0;
	let lastRunErrored = false;
	let reviewer: ChildProcess | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		const status = checking ? "continue: checking…" : enabled ? "continue: on" : undefined;
		ctx.ui.setStatus("auto-continue", status);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext, notify = true): void {
		enabled = next;
		if (next) continuations = 0;
		pi.appendEntry(STATE_TYPE, { enabled });
		updateStatus(ctx);
		if (notify) ctx.ui.notify(`Auto-continue ${enabled ? "enabled" : "disabled"}`, "info");
	}

	async function runGoalReviewer(ctx: ExtensionContext): Promise<GoalReview> {
		const fastAgent = discoverAgents(ctx.cwd, "user").agents.find((agent) => agent.name === "fast");
		if (!fastAgent?.model) throw new Error('Auto-continue requires the user-scoped "fast" agent with a model.');

		const prompt = [
			"You are an independent completion reviewer. Decide whether the active coding session has accomplished the user's actual goals.",
			"Judge requested deliverables and appropriate verification, not optional polish. Do not continue merely because more enhancements are possible.",
			"If work remains that the coding agent can perform autonomously, choose continue and give one concrete next instruction.",
			"If the goal is complete, choose complete. If progress requires a user decision or missing information, choose wait.",
			'Output exactly one JSON object: {"decision":"complete|continue|wait","reason":"brief evidence","next":"concrete next instruction when continuing"}',
			"SESSION TRANSCRIPT:",
			sessionTranscript(ctx),
		].join("\n\n");
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--model",
			fastAgent.model,
			"--thinking",
			fastAgent.thinking ?? "low",
			prompt,
		];
		const invocation = getPiInvocation(args);
		const messages: Message[] = [];
		let stdoutBuffer = "";
		let stderr = "";

		const child = spawn(invocation.command, invocation.args, {
			cwd: ctx.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		reviewer = child;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				if (event.type === "message_end" && event.message) messages.push(event.message);
			} catch {
				// Ignore non-JSON stdout diagnostics.
			}
		};
		child.stdout?.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
		});

		try {
			const exitCode = await new Promise<number>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code ?? 1));
			});
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			const output = finalAssistantText(messages);
			if (exitCode !== 0 || !output) {
				throw new Error(stderr.trim() || `Goal reviewer exited with code ${exitCode}.`);
			}
			return parseGoalReview(output);
		} finally {
			if (reviewer === child) reviewer = undefined;
		}
	}

	async function assessAndMaybeContinue(ctx: ExtensionContext): Promise<void> {
		if (!enabled || checking || ctx.hasPendingMessages() || !ctx.isIdle()) return;
		const reviewedLeafId = ctx.sessionManager.getLeafId();
		let recheck = false;
		checking = true;
		updateStatus(ctx);
		try {
			const review = await runGoalReviewer(ctx);
			if (!enabled) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.sessionManager.getLeafId() !== reviewedLeafId) {
				recheck = true;
				return;
			}
			pi.appendEntry<GoalReview>(REVIEW_TYPE, review);

			if (review.decision === "complete") {
				setEnabled(false, ctx, false);
				ctx.ui.notify(`Goal check: complete — ${review.reason}`, "info");
				return;
			}
			if (review.decision === "wait") {
				ctx.ui.notify(`Goal check: waiting for you — ${review.reason}`, "info");
				return;
			}
			if (continuations >= MAX_AUTONOMOUS_CONTINUATIONS) {
				setEnabled(false, ctx, false);
				ctx.ui.notify(
					`Auto-continue stopped after ${MAX_AUTONOMOUS_CONTINUATIONS} continuations.`,
					"warning",
				);
				return;
			}

			continuations += 1;
			const next = review.next ?? CONTINUE_PROMPT;
			pi.sendUserMessage(
				`Independent goal check: work remains. Continue autonomously.\n\nReason: ${review.reason}\n\nNext: ${next}`,
			);
		} catch (error) {
			if (enabled) {
				ctx.ui.notify(
					`Goal check failed; no continuation sent: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		} finally {
			checking = false;
			updateStatus(ctx);
			if (recheck && enabled && ctx.isIdle() && !ctx.hasPendingMessages()) {
				queueMicrotask(() => void assessAndMaybeContinue(ctx));
			}
		}
	}

	pi.registerEntryRenderer<GoalReview>(REVIEW_TYPE, (entry, _options, theme) => {
		const review = entry.data;
		if (!review) return new Text(theme.fg("dim", "goal check: unavailable"), 0, 0);
		const color = review.decision === "continue" ? "warning" : review.decision === "complete" ? "success" : "muted";
		return new Text(theme.fg(color, `goal check: ${review.decision}`) + theme.fg("dim", ` — ${review.reason}`), 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		checking = false;
		continuations = 0;
		lastRunErrored = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				enabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
			}
		}
		updateStatus(ctx);
	});

	pi.registerCommand("continue", {
		description: "Toggle reviewer-gated automatic continuation (on|off)",
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
			if (enabled) await assessAndMaybeContinue(ctx);
		},
	});

	pi.on("agent_end", (event) => {
		lastRunErrored = endedWithError(event.messages);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || lastRunErrored) return;
		await assessAndMaybeContinue(ctx);
	});

	pi.on("session_shutdown", () => {
		enabled = false;
		checking = false;
		lastRunErrored = false;
		reviewer?.kill("SIGTERM");
		reviewer = undefined;
	});
}
