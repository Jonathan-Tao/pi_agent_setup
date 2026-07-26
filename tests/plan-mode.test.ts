import assert from "node:assert/strict";
import test from "node:test";
import planModeExtension from "../extensions/plan-mode/index.ts";

test("fresh-session execution is staged as a command instead of sent to the model", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => unknown>();
	const sentMessages: string[] = [];
	const editorText: string[] = [];
	const replacementMessages: string[] = [];
	const pi = {
		registerFlag() {},
		registerShortcut() {},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, options.handler);
		},
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getAllTools: () => [{ name: "read" }, { name: "edit" }],
		getActiveTools: () => ["read", "edit"],
		setActiveTools() {},
		appendEntry() {},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
	} as any;
	planModeExtension(pi);

	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		setStatus() {},
		notify() {},
		setEditorText(text: string) {
			editorText.push(text);
		},
		select: async () => "Execute plan (clear planning context)",
	};
	const eventCtx = { hasUI: true, ui };
	await commands.get("plan")?.("", eventCtx);
	await handlers.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n\n1. Make the change." }] }],
		},
		eventCtx,
	);

	assert.deepEqual(editorText, ["/plan-execute-clear"]);
	assert.deepEqual(sentMessages, []);

	await commands.get("plan-execute-clear")?.("", {
		ui,
		waitForIdle: async () => {},
		sessionManager: { getSessionFile: () => "/old-session.jsonl" },
		newSession: async (options: any) => {
			assert.equal(options.parentSession, "/old-session.jsonl");
			await options.setup({ appendCustomEntry() {} });
			await options.withSession({
				sendUserMessage: async (message: string) => replacementMessages.push(message),
			});
			return { cancelled: false };
		},
	});

	assert.equal(replacementMessages.length, 1);
	assert.match(replacementMessages[0]!, /Plan mode is now inactive/);
	assert.match(replacementMessages[0]!, /1\. Make the change\./);
});
