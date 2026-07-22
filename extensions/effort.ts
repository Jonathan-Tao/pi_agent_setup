/**
 * Effort Extension
 *
 * Configure reasoning/thinking effort via /effort.
 *
 * Usage:
 * - `/effort`           show selector (or print current level)
 * - `/effort high`      set level directly
 * - `/effort medium`    off | minimal | low | medium | high | xhigh | max
 *
 * Also persists as defaultThinkingLevel (same as Shift+Tab cycling).
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

function normalizeLevel(raw: string): ThinkingLevel | undefined {
	const level = raw.trim().toLowerCase() as ThinkingLevel;
	return ALL_LEVELS.includes(level) ? level : undefined;
}

function availableLevels(ctx: ExtensionContext): ThinkingLevel[] {
	if (!ctx.model) {
		return ALL_LEVELS;
	}
	if (!ctx.model.reasoning) {
		return ["off"];
	}
	return getSupportedThinkingLevels(ctx.model) as ThinkingLevel[];
}

function applyLevel(pi: ExtensionAPI, ctx: ExtensionContext, level: ThinkingLevel): void {
	const available = availableLevels(ctx);
	if (!available.includes(level)) {
		ctx.ui.notify(
			`Level "${level}" not supported for current model. Available: ${available.join(", ")}`,
			"warning",
		);
		return;
	}

	const previous = pi.getThinkingLevel();
	pi.setThinkingLevel(level);
	const effective = pi.getThinkingLevel();

	if (effective === previous) {
		ctx.ui.notify(`Effort already ${effective}`, "info");
		return;
	}

	const clamped = effective !== level ? ` (clamped from ${level})` : "";
	ctx.ui.notify(`Effort: ${effective}${clamped}`, "info");
}

async function showSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const current = pi.getThinkingLevel();
	const levels = availableLevels(ctx);

	const items: SelectItem[] = levels.map((level) => ({
		value: level,
		label: level === current ? `${level} (current)` : level,
		description: LEVEL_DESCRIPTIONS[level],
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Reasoning Effort"))));
		container.addChild(new Text(theme.fg("dim", `current: ${current}`)));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		const currentIndex = items.findIndex((item) => item.value === current);
		if (currentIndex >= 0) {
			selectList.setSelectedIndex(currentIndex);
		}

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!result) {
		return;
	}

	const level = normalizeLevel(result);
	if (level) {
		applyLevel(pi, ctx, level);
	}
}

export default function effortExtension(pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Set reasoning effort (off|minimal|low|medium|high|xhigh|max)",
		getArgumentCompletions: (prefix: string) => {
			const q = prefix.trim().toLowerCase();
			const matches = ALL_LEVELS.filter((level) => level.startsWith(q)).map((level) => ({
				value: level,
				label: level,
				description: LEVEL_DESCRIPTIONS[level],
			}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (!raw) {
				if (ctx.mode === "tui" || ctx.hasUI) {
					await showSelector(pi, ctx);
					return;
				}
				ctx.ui.notify(
					`Effort: ${pi.getThinkingLevel()} (available: ${availableLevels(ctx).join(", ")})`,
					"info",
				);
				return;
			}

			const level = normalizeLevel(raw);
			if (!level) {
				ctx.ui.notify(
					`Invalid effort "${raw}". Use: ${ALL_LEVELS.join(", ")}`,
					"error",
				);
				return;
			}

			applyLevel(pi, ctx, level);
		},
	});
}
