import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface Profile {
	provider?: string;
	model?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools: string[];
	instructions?: string;
}

type Profiles = Record<string, Profile>;

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: Profile["thinkingLevel"];
	tools: string[];
}

function readProfiles(path: string): Profiles {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Profiles;
	} catch (error) {
		console.error(`Failed to load profiles from ${path}: ${error}`);
		return {};
	}
}

function loadProfiles(cwd: string): Profiles {
	return {
		...readProfiles(join(getAgentDir(), "profiles.json")),
		...readProfiles(join(cwd, CONFIG_DIR_NAME, "profiles.json")),
	};
}

export default function profileExtension(pi: ExtensionAPI) {
	let profiles: Profiles = {};
	let activeName: string | undefined;
	let activeProfile: Profile | undefined;
	let originalState: OriginalState | undefined;

	pi.registerFlag("profile", {
		description: "Tool profile to activate",
		type: "string",
	});

	function describe(name: string, profile: Profile): string {
		const missing = new Set(profile.tools.filter((tool) => !pi.getAllTools().some((item) => item.name === tool)));
		const tools = profile.tools.map((tool) => (missing.has(tool) ? `${tool} (unavailable)` : tool));
		const details = [`tools: ${tools.join(", ") || "none"}`];
		if (profile.thinkingLevel) details.push(`thinking: ${profile.thinkingLevel}`);
		if (profile.provider && profile.model) details.push(`model: ${profile.provider}/${profile.model}`);
		return `${name}${name === activeName ? " (active)" : ""} — ${details.join(" | ")}`;
	}

	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus("profile", activeName ? ctx.ui.theme.fg("accent", `profile:${activeName}`) : undefined);
	}

	async function apply(name: string, profile: Profile, ctx: ExtensionContext) {
		if (!originalState) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		if (profile.provider && profile.model) {
			const model = ctx.modelRegistry.find(profile.provider, profile.model);
			if (!model) ctx.ui.notify(`Profile "${name}": model not found`, "warning");
			else if (!(await pi.setModel(model))) ctx.ui.notify(`Profile "${name}": model has no credentials`, "warning");
		}
		if (profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);

		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const valid = profile.tools.filter((tool) => available.has(tool));
		const missing = profile.tools.filter((tool) => !available.has(tool));
		pi.setActiveTools(valid);
		if (missing.length) ctx.ui.notify(`Profile "${name}": unavailable tools: ${missing.join(", ")}`, "warning");

		activeName = name;
		activeProfile = profile;
		pi.appendEntry("profile-state", { name });
		updateStatus(ctx);
	}

	async function clear(ctx: ExtensionContext) {
		activeName = undefined;
		activeProfile = undefined;
		if (originalState) {
			if (originalState.model) await pi.setModel(originalState.model);
			if (originalState.thinkingLevel) pi.setThinkingLevel(originalState.thinkingLevel);
			pi.setActiveTools(originalState.tools);
		}
		pi.appendEntry("profile-state", { name: null });
		updateStatus(ctx);
	}

	pi.registerCommand("profile", {
		description: "List or activate tool profiles",
		getArgumentCompletions: (prefix) => {
			const names = [...Object.keys(profiles), "none"];
			const items = names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested === "none") {
				await clear(ctx);
				ctx.ui.notify("Profile cleared", "info");
				return;
			}
			if (requested) {
				const profile = profiles[requested];
				if (!profile) {
					ctx.ui.notify(`Unknown profile "${requested}"`, "error");
					return;
				}
				await apply(requested, profile, ctx);
				ctx.ui.notify(`Profile "${requested}" activated`, "info");
				return;
			}

			const names = Object.keys(profiles).sort();
			if (!names.length) {
				ctx.ui.notify(`No profiles found in ${join(getAgentDir(), "profiles.json")}`, "warning");
				return;
			}
			const choices = names.map((name) => describe(name, profiles[name]));
			choices.push("none — restore tools active before the first profile");
			const selected = await ctx.ui.select("Profiles and agent tools", choices);
			if (!selected) return;
			const name = selected.split(" — ", 1)[0].replace(/ \(active\)$/, "");
			if (name === "none") await clear(ctx);
			else await apply(name, profiles[name], ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (activeProfile?.instructions) return { systemPrompt: `${event.systemPrompt}\n\n${activeProfile.instructions}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		profiles = loadProfiles(ctx.cwd);
		const flag = pi.getFlag("profile");
		let requested = typeof flag === "string" ? flag : undefined;
		if (!requested) {
			const state = ctx.sessionManager.getEntries()
				.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "profile-state")
				.pop() as { data?: { name?: string | null } } | undefined;
			requested = state?.data?.name ?? undefined;
		}
		if (requested && profiles[requested]) await apply(requested, profiles[requested], ctx);
		else if (requested) ctx.ui.notify(`Unknown profile "${requested}"`, "warning");
		updateStatus(ctx);
	});
}
