import assert from "node:assert/strict";
import test from "node:test";
import autoContinueExtension, { parseGoalReview } from "../extensions/auto-continue.ts";

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

test("defers goal assessment until other settled handlers can queue messages", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry() {},
		registerEntryRenderer() {},
		registerCommand() {},
	} as any;
	autoContinueExtension(pi);

	let pending = false;
	let pendingChecks = 0;
	const notifications: string[] = [];
	const ctx = {
		hasPendingMessages() {
			pendingChecks += 1;
			return pending;
		},
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "auto-continue-state", data: { enabled: true } }],
			getLeafId: () => "leaf",
		},
		ui: {
			setStatus() {},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};

	await handlers.get("session_start")?.[0]?.({}, ctx);
	handlers.get("agent_settled")?.[0]?.({}, ctx);
	assert.equal(pendingChecks, 0, "assessment ran inside the settled handler");

	pending = true;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pendingChecks, 1);
	assert.deepEqual(notifications, []);

	await handlers.get("session_shutdown")?.[0]?.({}, ctx);
});
