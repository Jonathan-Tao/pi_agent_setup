/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Known mutating or destructive commands blocked in plan mode. This is a
// guardrail, not a shell sandbox: investigation commands are allowed unless
// an executable at a shell-command boundary matches one of these patterns.
const COMMAND_PREFIX = String.raw`(?:^|(?:&&|\|\||[;|\n])\s*)(?:(?:command|env)\s+)?`;
const commandPattern = (body: string): RegExp => new RegExp(`${COMMAND_PREFIX}\\s*${body}`, "i");

const DESTRUCTIVE_PATTERNS = [
	commandPattern(String.raw`(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b`),
	commandPattern(String.raw`npm\s+(?:install|uninstall|update|ci|link|publish)\b`),
	commandPattern(String.raw`yarn\s+(?:add|remove|install|publish)\b`),
	commandPattern(String.raw`pnpm\s+(?:add|remove|install|publish)\b`),
	commandPattern(String.raw`pip\s+(?:install|uninstall)\b`),
	commandPattern(String.raw`apt(?:-get)?\s+(?:install|remove|purge|update|upgrade)\b`),
	commandPattern(String.raw`brew\s+(?:install|uninstall|upgrade)\b`),
	commandPattern(
		String.raw`git(?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+|--(?:git-dir|work-tree|namespace)=\S+|--(?:no-pager|paginate|bare|literal-pathspecs|no-optional-locks)))*\s+(?:add|commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone|worktree|submodule\s+(?:add|update|deinit)|branch\s+-[dDmM])\b`,
	),
	commandPattern(String.raw`(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b`),
	commandPattern(String.raw`systemctl\s+(?:start|stop|restart|enable|disable)\b`),
	commandPattern(String.raw`service\s+\S+\s+(?:start|stop|restart)\b`),
	commandPattern(String.raw`(?:vim?|nano|emacs|code|subl)\b`),
	commandPattern(String.raw`(?:eval|(?:ba|z|fi)?sh\s+-c)\b`),
	/(^|[^<])>(?!>)/,
	/>>/,
];

export function isSafeCommand(command: string): boolean {
	// Discard redirects to /dev/null; they suppress diagnostics without changing
	// meaningful state and are common in reconnaissance commands.
	const normalized = command
		.replace(/\d*>>?\s*\/dev\/null\b/g, "")
		// Quoted search patterns and arguments are data, not shell commands.
		.replace(/'(?:[^']*)'/g, "''")
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
	return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	// Keep full step text for execution — UI can truncate for display.
	return cleaned;
}

/** Extract the Plan: section body (without the header), or empty string. */
export function extractPlanSection(message: string): string {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch || headerMatch.index === undefined) return "";
	return message.slice(headerMatch.index + headerMatch[0].length).trim();
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const planSection = extractPlanSection(message);
	if (!planSection) return items;

	// Allow rest-of-line detail (not just until first *)
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}/g, "")
			.replace(/\s+/g, " ")
			.trim();
		// Skip tiny / non-step lines
		if (text.length > 3 && !text.startsWith("```")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

/** Short label for widgets / status (full text stays on TodoItem.text). */
export function shortStepLabel(text: string, max = 56): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max - 1)}…`;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
