import assert from "node:assert/strict";
import test from "node:test";
import autoContinueExtension, { parseGoalReview, sessionTranscript } from "../extensions/auto-continue.ts";

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

test("reviews the compaction-aware context", () => {
	const ctx = {
		sessionManager: {
			buildContextEntries: () => [
				{ type: "compaction", summary: "Earlier implementation and decisions." },
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Run the remaining check." }] },
				},
			],
		},
	} as any;

	assert.equal(
		sessionTranscript(ctx),
		"SESSION SUMMARY:\nEarlier implementation and decisions.\n\n---\n\nUSER:\nRun the remaining check.",
	);
});

test("waits for background terminals and defers assessment past settled handlers", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => unknown>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, handler: (data: unknown) => unknown) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
			},
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
			buildContextEntries: () => [],
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
	eventHandlers.get("background-terminals:running-count")?.[0]?.({ running: 1 });
	handlers.get("agent_settled")?.[0]?.({}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pendingChecks, 0, "assessment ran while a background terminal was active");

	eventHandlers.get("background-terminals:running-count")?.[0]?.({ running: 0 });
	handlers.get("agent_settled")?.[0]?.({}, ctx);
	assert.equal(pendingChecks, 0, "assessment ran inside the settled handler");

	pending = true;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pendingChecks, 1);
	assert.deepEqual(notifications, []);

	await handlers.get("session_shutdown")?.[0]?.({}, ctx);
});
