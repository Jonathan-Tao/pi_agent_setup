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

test("keeps goal mode and auto-continue mutually exclusive", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => unknown>();
	const entries: Array<{ enabled?: boolean; goal?: string; continuations?: number }> = [];
	const messages: Array<{ content: string; options: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { on() {} },
		appendEntry(_type: string, data: { enabled?: boolean; goal?: string; continuations?: number }) {
			entries.push(data);
		},
		registerEntryRenderer() {},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, options.handler);
		},
		sendUserMessage(content: string, options: unknown) {
			messages.push({ content, options });
		},
	} as any;
	autoContinueExtension(pi);

	const ctx = {
		hasPendingMessages: () => false,
		isIdle: () => false,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "auto-continue-state", data: { enabled: true, continuations: 7 } },
			],
		},
		ui: {
			setStatus() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	await handlers.get("session_start")?.[0]?.({}, ctx);
	await commands.get("goal")?.("Finish the migration", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "Auto-continue is active. Run /continue off before setting a goal.",
		level: "error",
	});
	assert.equal(messages.length, 0);

	await commands.get("continue")?.("off", ctx);
	assert.deepEqual(entries.at(-1), { enabled: false, goal: undefined, continuations: 7 });
	await commands.get("goal")?.("Finish the migration", ctx);
	assert.deepEqual(entries.at(-1), { enabled: false, goal: "Finish the migration", continuations: 0 });
	assert.deepEqual(messages, []);

	const entryCount = entries.length;
	await commands.get("goal")?.("Finish the migration", ctx);
	assert.equal(entries.length, entryCount);
	assert.deepEqual(notifications.at(-1), {
		message: "Goal mode already active: Finish the migration",
		level: "info",
	});

	await commands.get("continue")?.("on", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "Goal mode is active. Run /goal off before enabling /continue.",
		level: "error",
	});

	const promptResult = await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx) as
		| { systemPrompt: string }
		| undefined;
	assert.match(promptResult?.systemPrompt ?? "", /\[ACTIVE GOAL\]\nFinish the migration/);
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
