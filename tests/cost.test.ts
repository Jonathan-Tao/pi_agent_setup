import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCostEntries, type StoredCostEntry } from "../extensions/cost.ts";

function usage(cost: number, tokens: number) {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { total: cost },
	};
}

test("aggregates model and month costs without counting copied fork entries", async () => {
	const july = new Date(2026, 6, 10, 12).toISOString();
	const august = new Date(2026, 7, 10, 12).toISOString();
	const copiedAssistant: StoredCostEntry = {
		type: "message",
		id: "assistant-1",
		timestamp: july,
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			responseId: "response-1",
			usage: usage(2, 100),
		},
	};
	const entries: StoredCostEntry[] = [
		copiedAssistant,
		{ ...copiedAssistant },
		{
			type: "message",
			id: "assistant-2",
			timestamp: august,
			message: {
				role: "assistant",
				provider: "xai",
				model: "router",
				responseModel: "grok-4.5",
				usage: usage(3, 200),
			},
		},
		{
			type: "message",
			id: "tool-1",
			timestamp: august,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				usage: usage(0.5, 50),
			},
		},
		{
			type: "compaction",
			id: "summary-1",
			timestamp: august,
			usage: usage(0.25, 25),
		},
	];

	const summary = await aggregateCostEntries(entries);

	assert.deepEqual(summary.total, { cost: 5.75, tokens: 375, records: 4 });
	assert.equal(summary.deduplicatedRecords, 1);
	assert.deepEqual(
		summary.byModel.map(({ key, cost, records }) => ({ key, cost, records })),
		[
			{ key: "xai/grok-4.5", cost: 3, records: 1 },
			{ key: "openai-codex/gpt-5.6-sol", cost: 2, records: 1 },
			{ key: "Tools/summaries", cost: 0.75, records: 2 },
		],
	);
	assert.deepEqual(
		summary.byMonth.map(({ key, cost }) => ({ key, cost })),
		[
			{ key: "2026-08", cost: 3.75 },
			{ key: "2026-07", cost: 2 },
		],
	);
});
