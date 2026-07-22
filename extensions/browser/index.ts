import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ACTIONS = ["navigate", "snapshot", "click", "fill", "press", "screenshot", "evaluate", "close"] as const;
const WAIT_UNTIL = ["commit", "domcontentloaded", "load", "networkidle"] as const;

function clip(text: string): string {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}]`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: clip(text) }], details };
}

export default function browserExtension(pi: ExtensionAPI) {
	let browser: Browser | undefined;
	let page: Page | undefined;
	const consoleMessages: string[] = [];

	async function getPage(): Promise<Page> {
		if (page && !page.isClosed()) return page;
		browser ??= await chromium.launch({ headless: true });
		page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		page.on("console", (message) => {
			consoleMessages.push(`[console.${message.type()}] ${message.text()}`);
			if (consoleMessages.length > 50) consoleMessages.shift();
		});
		page.on("pageerror", (error) => {
			consoleMessages.push(`[pageerror] ${error.message}`);
			if (consoleMessages.length > 50) consoleMessages.shift();
		});
		return page;
	}

	function locatorFor(currentPage: Page, selector: string) {
		const trimmed = selector.trim();
		return /^e\d+$/.test(trimmed)
			? currentPage.locator(`[data-pi-ref="${trimmed}"]`)
			: currentPage.locator(trimmed);
	}

	async function snapshot(currentPage: Page): Promise<string> {
		const interactive = await currentPage.locator("a,button,input,textarea,select,[role],[contenteditable=true]").evaluateAll(
			(elements) => elements.slice(0, 200).map((element, index) => {
				const ref = `e${index + 1}`;
				element.setAttribute("data-pi-ref", ref);
				const html = element as HTMLElement;
				const input = element as HTMLInputElement;
				const label = html.innerText?.trim() || input.value || element.getAttribute("aria-label") ||
					element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("alt") || "";
				return {
					ref,
					tag: element.tagName.toLowerCase(),
					role: element.getAttribute("role"),
					type: element.getAttribute("type"),
					label: label.replace(/\s+/g, " ").slice(0, 160),
				};
			}),
		);
		const bodyText = await currentPage.locator("body").innerText().catch(() => "");
		const lines = [
			`URL: ${currentPage.url()}`,
			`Title: ${await currentPage.title()}`,
			"",
			"Interactive elements (use ref such as e1, or a CSS selector):",
			...interactive.map((item) => `${item.ref}: ${item.tag}${item.role ? ` role=${item.role}` : ""}${item.type ? ` type=${item.type}` : ""} ${JSON.stringify(item.label)}`),
			"",
			"Page text:",
			bodyText,
		];
		if (consoleMessages.length) lines.push("", "Recent console output:", ...consoleMessages.slice(-20));
		return lines.join("\n");
	}

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: "Control a persistent headless Chromium browser for web development. Navigate, inspect interactive elements and page text, click, fill, press keys, take screenshots, evaluate JavaScript, or close the browser. Snapshot output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Automate a Chromium browser to inspect and test web pages",
		promptGuidelines: [
			"Use browser snapshot after navigation and interactions to inspect the current page and obtain element refs such as e1.",
			"Use browser screenshots when visual layout matters.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "Browser action" }),
			url: Type.Optional(Type.String({ description: "URL for navigate" })),
			selector: Type.Optional(Type.String({ description: "Element ref from snapshot (e.g. e1) or CSS selector" })),
			value: Type.Optional(Type.String({ description: "Text for fill" })),
			key: Type.Optional(Type.String({ description: "Key for press, e.g. Enter or Control+A" })),
			script: Type.Optional(Type.String({ description: "JavaScript expression for evaluate" })),
			path: Type.Optional(Type.String({ description: "Optional screenshot output path" })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page (default true)" })),
			waitUntil: Type.Optional(StringEnum(WAIT_UNTIL, { description: "Navigation readiness event (default domcontentloaded)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Browser action cancelled");
			if (params.action === "close") {
				await browser?.close();
				browser = undefined;
				page = undefined;
				consoleMessages.length = 0;
				return textResult("Browser closed.");
			}

			const currentPage = await getPage();
			switch (params.action) {
				case "navigate": {
					if (!params.url) throw new Error("navigate requires url");
					const url = new URL(params.url);
					if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// URLs are supported");
					await currentPage.goto(url.href, { waitUntil: params.waitUntil ?? "domcontentloaded", timeout: 30_000 });
					return textResult(await snapshot(currentPage), { url: currentPage.url() });
				}
				case "snapshot":
					return textResult(await snapshot(currentPage), { url: currentPage.url() });
				case "click": {
					if (!params.selector) throw new Error("click requires selector");
					await locatorFor(currentPage, params.selector).first().click({ timeout: 15_000 });
					await currentPage.waitForTimeout(200);
					return textResult(await snapshot(currentPage), { url: currentPage.url() });
				}
				case "fill": {
					if (!params.selector || params.value === undefined) throw new Error("fill requires selector and value");
					await locatorFor(currentPage, params.selector).first().fill(params.value, { timeout: 15_000 });
					return textResult(await snapshot(currentPage), { url: currentPage.url() });
				}
				case "press": {
					if (!params.selector || !params.key) throw new Error("press requires selector and key");
					await locatorFor(currentPage, params.selector).first().press(params.key, { timeout: 15_000 });
					await currentPage.waitForTimeout(200);
					return textResult(await snapshot(currentPage), { url: currentPage.url() });
				}
				case "screenshot": {
					const outputPath = params.path
						? (isAbsolute(params.path) ? params.path : join(ctx.cwd, params.path))
						: join(tmpdir(), `pi-browser-${Date.now()}.png`);
					await fs.mkdir(dirname(outputPath), { recursive: true });
					const image = await currentPage.screenshot({ path: outputPath, fullPage: params.fullPage ?? true, type: "png" });
					return {
						content: [
							{ type: "text" as const, text: `Screenshot saved to ${outputPath}` },
							{ type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: image.toString("base64") } },
						],
						details: { path: outputPath, url: currentPage.url() },
					};
				}
				case "evaluate": {
					if (!params.script) throw new Error("evaluate requires script");
					const result = await currentPage.evaluate((source) => (0, eval)(source), params.script);
					return textResult(JSON.stringify(result, null, 2) ?? "undefined", { url: currentPage.url() });
				}
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await browser?.close();
		browser = undefined;
		page = undefined;
	});
}
