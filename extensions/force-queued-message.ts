import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EditorConstructorArgs = ConstructorParameters<typeof CustomEditor>;

class ForceQueuedMessageEditor extends CustomEditor {
	constructor(
		tui: EditorConstructorArgs[0],
		theme: EditorConstructorArgs[1],
		keybindings: EditorConstructorArgs[2],
		private readonly shouldForce: (data: string) => boolean,
		private readonly force: () => void,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (this.getText().trim() === "" && this.shouldForce(data)) {
			this.force();
			return;
		}

		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	let forcedMessage: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new ForceQueuedMessageEditor(
					tui,
					theme,
					keybindings,
					(data) => keybindings.matches(data, "tui.input.submit") && !ctx.isIdle() && ctx.hasPendingMessages(),
					() => {
						ctx.abort();
						const message = ctx.ui.getEditorText().trim();
						if (!message) return;

						forcedMessage = message;
						ctx.ui.setEditorText("");
						ctx.ui.notify("Forcing queued message through", "info");
					},
				),
		);
	});

	pi.on("agent_settled", (_event, _ctx) => {
		if (!forcedMessage) return;

		const message = forcedMessage;
		forcedMessage = undefined;
		pi.sendUserMessage(message);
	});

	pi.on("session_shutdown", () => {
		forcedMessage = undefined;
	});
}
