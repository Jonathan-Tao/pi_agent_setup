import * as os from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function compactNumber(value: number) {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function sessionCost(ctx: ExtensionContext) {
	let total = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			total += entry.message.usage.cost.total;
		}
	}
	return total;
}

function compactPath(cwd: string) {
	const home = os.homedir();
	return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function columns(left: string, right: string, width: number) {
	if (!right) return truncateToWidth(left, width);
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap > 0) return `${left}${" ".repeat(gap)}${right}`;
	const leftWidth = Math.max(1, Math.floor(width * 0.48));
	const rightWidth = Math.max(1, width - leftWidth - 1);
	return `${truncateToWidth(left, leftWidth)} ${truncateToWidth(right, rightWidth)}`;
}

export default function dashboardFooter(pi: ExtensionAPI) {
	let changedFiles = 0;
	let inRepository = false;
	let requestRender: (() => void) | undefined;
	let refreshGeneration = 0;

	async function refreshGit(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		const generation = ++refreshGeneration;
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd: ctx.cwd,
			timeout: 3_000,
		});
		if (generation !== refreshGeneration) return;
		inRepository = result.code === 0;
		changedFiles = inRepository
			? result.stdout.split("\n").filter((line) => line.length > 0).length
			: 0;
		requestRender?.();
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		void refreshGit(ctx);

		ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
			requestRender = () => tui.requestRender();
			const stopBranchListener = footerData.onBranchChange(() => {
				void refreshGit(ctx);
				tui.requestRender();
			});

			return {
				invalidate() {},
				dispose: stopBranchListener,
				render(width: number) {
					const usage = ctx.getContextUsage();
					const context =
						usage?.percent !== null && usage?.contextWindow != null
							? `${Math.round(usage.percent)}%/${compactNumber(usage.contextWindow)}`
							: "context ?";
					const model = ctx.model
						? `${ctx.model.provider}/${ctx.model.id} · ${pi.getThinkingLevel()}`
						: "no model";
					const branch = footerData.getGitBranch();
					const git = inRepository
						? `${branch ?? "detached"} · ${changedFiles} changed`
						: "";
					const lines = [
						columns(theme.fg("text", compactPath(ctx.cwd)), theme.fg("muted", model), width),
						columns(
							theme.fg("muted", `${context} · $${sessionCost(ctx).toFixed(2)}`),
							theme.fg("muted", git),
							width,
						),
					];
					for (const status of footerData.getExtensionStatuses().values()) {
						for (const line of status.split("\n")) lines.push(truncateToWidth(line, width));
					}
					return lines;
				},
			};
		});
	});

	pi.on("input", (_event, ctx) => {
		void refreshGit(ctx);
		return { action: "continue" };
	});
	pi.on("tool_execution_end", (_event, ctx) => void refreshGit(ctx));
	pi.on("message_end", (_event, _ctx) => requestRender?.());

	pi.on("session_shutdown", (_event, ctx) => {
		refreshGeneration += 1;
		requestRender = undefined;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
