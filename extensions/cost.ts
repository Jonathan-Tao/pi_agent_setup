import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total: number };
}

export interface StoredCostEntry {
	type: string;
	id?: string;
	timestamp?: string;
	usage?: Usage;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		responseModel?: string;
		responseId?: string;
		toolCallId?: string;
		timestamp?: number;
		usage?: Usage;
	};
}

interface Totals {
	cost: number;
	tokens: number;
	records: number;
}

export interface CostBreakdown extends Totals {
	key: string;
}

export interface CostSummary {
	total: Totals;
	byModel: CostBreakdown[];
	byMonth: CostBreakdown[];
	deduplicatedRecords: number;
}

interface CostRecord {
	identity: string;
	month: string;
	model: string;
	cost: number;
	tokens: number;
}

function monthKey(timestamp: string) {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid session timestamp: ${timestamp}`);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function extractCostRecord(entry: StoredCostEntry): CostRecord | undefined {
	let usage: Usage | undefined;
	let model: string | undefined;
	let identityDetail = "";

	if (entry.type === "message" && entry.message?.role === "assistant") {
		usage = entry.message.usage;
		model = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
		identityDetail = entry.message.responseId ?? "";
	} else if (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.usage
	) {
		usage = entry.message.usage;
		model = "Tools/summaries";
		identityDetail = entry.message.toolCallId ?? "";
	} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
		usage = entry.usage;
		model = "Tools/summaries";
	}

	if (!usage || !model) return undefined;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost?.total ?? 0;
	if (cost === 0 && tokens === 0) return undefined;
	if (!entry.timestamp) throw new Error(`Usage entry ${entry.id ?? "without an ID"} has no timestamp`);

	return {
		identity: `${entry.type}\0${entry.id ?? ""}\0${entry.timestamp}\0${identityDetail}`,
		month: monthKey(entry.timestamp),
		model,
		cost,
		tokens,
	};
}

function addTotals(totals: Totals, record: CostRecord) {
	totals.cost += record.cost;
	totals.tokens += record.tokens;
	totals.records += 1;
}

function addBreakdown(map: Map<string, Totals>, key: string, record: CostRecord) {
	let totals = map.get(key);
	if (!totals) {
		totals = { cost: 0, tokens: 0, records: 0 };
		map.set(key, totals);
	}
	addTotals(totals, record);
}

export async function aggregateCostEntries(
	entries: AsyncIterable<StoredCostEntry> | Iterable<StoredCostEntry>,
): Promise<CostSummary> {
	const total: Totals = { cost: 0, tokens: 0, records: 0 };
	const models = new Map<string, Totals>();
	const months = new Map<string, Totals>();
	const identities = new Set<string>();
	let deduplicatedRecords = 0;

	for await (const entry of entries) {
		const record = extractCostRecord(entry);
		if (!record) continue;
		if (identities.has(record.identity)) {
			deduplicatedRecords += 1;
			continue;
		}
		identities.add(record.identity);
		addTotals(total, record);
		addBreakdown(models, record.model, record);
		addBreakdown(months, record.month, record);
	}

	const byModel = Array.from(models, ([key, totals]) => ({ key, ...totals })).sort(
		(a, b) => b.cost - a.cost || b.tokens - a.tokens,
	);
	const byMonth = Array.from(months, ([key, totals]) => ({ key, ...totals })).sort((a, b) =>
		b.key.localeCompare(a.key),
	);
	return { total, byModel, byMonth, deduplicatedRecords };
}

async function findSessionFiles(roots: string[]) {
	const files = new Set<string>();
	const normalizedRoots = [...new Set(roots.map((root) => resolve(root)))]
		.sort((a, b) => a.length - b.length)
		.filter((root, index, all) => !all.slice(0, index).some((parent) => root.startsWith(`${parent}${sep}`)));

	async function visit(directory: string) {
		let entries;
		try {
			entries = await opendir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for await (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(path);
		}
	}

	for (const root of normalizedRoots) await visit(root);
	return [...files].sort();
}

async function* readSessionEntries(files: string[]): AsyncGenerator<StoredCostEntry> {
	for (const file of files) {
		const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line) continue;
			try {
				yield JSON.parse(line) as StoredCostEntry;
			} catch {
				// Pi also skips malformed session lines when it loads a session.
			}
		}
	}
}

function formatMoney(value: number) {
	return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatNumber(value: number) {
	return new Intl.NumberFormat().format(value);
}

function formatTokens(value: number) {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function currentMonthKey(now: Date) {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function projectedMonthlyCost(currentCost: number, now: Date) {
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	const elapsed = Math.max(1, now.getTime() - start.getTime());
	return currentCost * ((end.getTime() - start.getTime()) / elapsed);
}

export function formatCostSummary(summary: CostSummary, sessionFileCount: number, now = new Date()) {
	const currentMonth = summary.byMonth.find((month) => month.key === currentMonthKey(now));
	const currentCost = currentMonth?.cost ?? 0;
	const projectedCost = projectedMonthlyCost(currentCost, now);
	const lines = [
		"Pi cost estimate",
		"",
		`All time: ${formatMoney(summary.total.cost)} · ${formatTokens(summary.total.tokens)} tokens · ${formatNumber(summary.total.records)} usage records`,
		`Current month: ${formatMoney(currentCost)}`,
		`Projected monthly burn: ${formatMoney(projectedCost)}`,
		"",
		"By model",
	];

	for (const model of summary.byModel) {
		const share = summary.total.cost > 0 ? (model.cost / summary.total.cost) * 100 : 0;
		lines.push(
			`${model.key}: ${formatMoney(model.cost)} (${share.toFixed(1)}%) · ${formatTokens(model.tokens)} tokens · ${formatNumber(model.records)} records`,
		);
	}

	lines.push("", "Monthly burn");
	for (const month of summary.byMonth) {
		lines.push(
			`${month.key}: ${formatMoney(month.cost)} · ${formatTokens(month.tokens)} tokens · ${formatNumber(month.records)} records`,
		);
	}

	lines.push(
		"",
		`${formatNumber(sessionFileCount)} saved session files · ${formatNumber(summary.deduplicatedRecords)} copied fork records removed`,
		"Months use this machine's local time. These are local estimates from saved request-time prices. Provider bills, subscriptions, ephemeral sessions, and inactive custom session directories can differ.",
	);
	return lines.join("\n");
}

export default function costExtension(pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "Show all-time and monthly Pi cost estimates",
		handler: async (_args, ctx) => {
			const statusKey = "cost-summary";
			ctx.ui.setStatus(statusKey, "Calculating Pi cost...");
			try {
				const files = await findSessionFiles([
					join(getAgentDir(), "sessions"),
					ctx.sessionManager.getSessionDir(),
				]);
				const summary = await aggregateCostEntries(readSessionEntries(files));
				ctx.ui.notify(formatCostSummary(summary, files.length), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				ctx.ui.setStatus(statusKey, undefined);
			}
		},
	});
}
