import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalReview } from "../extensions/auto-continue.ts";

test("parses a direct continue decision", () => {
	assert.deepEqual(
		parseGoalReview('{"decision":"continue","reason":"Tests have not run.","next":"Run the tests."}'),
		{
			decision: "continue",
			reason: "Tests have not run.",
			next: "Run the tests.",
		},
	);
});

test("parses fenced completion JSON", () => {
	assert.deepEqual(parseGoalReview('```json\n{"decision":"complete","reason":"All requested checks passed."}\n```'), {
		decision: "complete",
		reason: "All requested checks passed.",
		next: undefined,
	});
});

test("rejects malformed reviewer output", () => {
	assert.throws(() => parseGoalReview("continue"), /invalid JSON/);
	assert.throws(() => parseGoalReview('{"decision":"maybe","reason":"unclear"}'), /unknown decision/);
});
