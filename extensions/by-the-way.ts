import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

interface BtwEntry {
	question: string;
	answer: string;
	model: string;
}

const SIDE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"fd",
	"rg",
	"google_search",
	"pdf",
];

function getPiInvocation(args: string[]) {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function assistantText(messages: Message[]) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export default function byTheWay(pi: ExtensionAPI) {
	const children = new Set<ChildProcess>();
	let running = false;

	pi.registerEntryRenderer<BtwEntry>("btw-result", (entry) => {
		const data = entry.data;
		if (!data) return new Markdown("_No /btw result data._", 0, 0, getMarkdownTheme());
		const markdown = [
			"### By the way",
			"",
			`**Question:** ${data.question}`,
			"",
			data.answer,
			"",
			`_${data.model}_`,
		].join("\n");
		return new Markdown(markdown, 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("btw", {
		description: "Ask a read-only one-off question in an isolated Pi context",
		handler: async (args, ctx) => {
			if (running) {
				ctx.ui.notify("A /btw question is already running.", "warning");
				return;
			}

			let question = args.trim();
			if (!question && ctx.hasUI) {
				question = (await ctx.ui.input("By the way", "Ask a side question"))?.trim() ?? "";
			}
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}

			const model = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const invocationArgs = [
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--tools",
				SIDE_TOOLS.join(","),
			];
			if (model) invocationArgs.push("--model", model);
			invocationArgs.push("--thinking", pi.getThinkingLevel());
			invocationArgs.push(
				[
					"Answer this one-off side question independently and concisely.",
					"This is read-only: investigate if useful, but do not modify files or system state.",
					`Question: ${question}`,
				].join("\n\n"),
			);

			running = true;
			ctx.ui.setStatus("btw", ctx.ui.theme.fg("muted", "btw: thinking…"));
			const messages: Message[] = [];
			let stderr = "";

			try {
				const invocation = getPiInvocation(invocationArgs);
				const child = spawn(invocation.command, invocation.args, {
					cwd: ctx.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				children.add(child);

				let buffer = "";
				const processLine = (line: string) => {
					if (!line.trim()) return;
					try {
						const event = JSON.parse(line) as { type?: string; message?: Message };
						if (event.type === "message_end" && event.message) messages.push(event.message);
					} catch {
						// Ignore non-JSON diagnostics; stderr is reported on failure.
					}
				};

				child.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				});
				child.stderr?.on("data", (chunk) => {
					stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
				});

				const exitCode = await new Promise<number>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code) => resolve(code ?? 1));
				});
				children.delete(child);
				if (buffer.trim()) processLine(buffer);

				const answer = assistantText(messages);
				if (exitCode !== 0 || !answer) {
					throw new Error(stderr.trim() || `Side Pi exited with code ${exitCode}.`);
				}

				pi.appendEntry<BtwEntry>("btw-result", {
					question,
					answer,
					model: model ?? "default model",
				});
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			} finally {
				running = false;
				ctx.ui.setStatus("btw", undefined);
			}
		},
	});

	pi.on("session_shutdown", () => {
		for (const child of children) child.kill("SIGTERM");
		children.clear();
		running = false;
	});
}
