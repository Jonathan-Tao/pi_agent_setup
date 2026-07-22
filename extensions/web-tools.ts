/**
 * Web + document tools:
 * - google_search: Google CSE if configured, else Brave, else DuckDuckGo fallback
 * - pdf: info / text extract / render pages to images
 *
 * Env for Google Custom Search:
 *   GOOGLE_API_KEY
 *   GOOGLE_CSE_ID  (or GOOGLE_SEARCH_ENGINE_ID)
 *
 * Optional:
 *   BRAVE_API_KEY  (used if Google keys missing)
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

type TextContent = { type: "text"; text: string };
type ImageContent = {
	type: "image";
	source: { type: "base64"; mediaType: string; data: string };
};
type Content = TextContent | ImageContent;

function textResult(text: string, details: Record<string, unknown> = {}) {
	// truncateHead returns { content, truncated, ... } (not .text)
	const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let body = trunc.content ?? "";
	if (trunc.truncated) {
		body += `\n\n[truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}]`;
	}
	return {
		content: [{ type: "text" as const, text: body }],
		details: { ...details, truncated: trunc.truncated },
	};
}

async function runCmd(
	cmd: string,
	args: string[],
	opts: { maxBuffer?: number; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			encoding: "utf-8",
			maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
			timeout: opts.timeout ?? 60_000,
		});
		return { stdout: stdout ?? "", stderr: stderr ?? "" };
	} catch (err: any) {
		if (typeof err.stdout === "string" || typeof err.stderr === "string") {
			const msg = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n");
			throw new Error(msg.trim() || `${cmd} failed`);
		}
		throw err;
	}
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

async function searchGoogle(query: string, count: number): Promise<{ engine: string; hits: SearchHit[] }> {
	const key = process.env.GOOGLE_API_KEY;
	const cx = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID;
	if (!key || !cx) {
		throw new Error("missing_google_keys");
	}
	const url = new URL("https://www.googleapis.com/customsearch/v1");
	url.searchParams.set("key", key);
	url.searchParams.set("cx", cx);
	url.searchParams.set("q", query);
	url.searchParams.set("num", String(Math.min(Math.max(count, 1), 10)));

	const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Google CSE HTTP ${res.status}: ${body.slice(0, 400)}`);
	}
	const data = (await res.json()) as {
		items?: Array<{ title?: string; link?: string; snippet?: string }>;
	};
	const hits = (data.items ?? []).map((i) => ({
		title: i.title ?? "(no title)",
		url: i.link ?? "",
		snippet: i.snippet ?? "",
	}));
	return { engine: "google-cse", hits };
}

async function searchBrave(query: string, count: number): Promise<{ engine: string; hits: SearchHit[] }> {
	const key = process.env.BRAVE_API_KEY;
	if (!key) throw new Error("missing_brave_key");

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));

	const res = await fetch(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": key },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Brave HTTP ${res.status}: ${body.slice(0, 400)}`);
	}
	const data = (await res.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
	};
	const hits = (data.web?.results ?? []).map((r) => ({
		title: r.title ?? "(no title)",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
	return { engine: "brave", hits };
}

function decodeBasicEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function unwrapDdgHref(href: string): string {
	try {
		const u = new URL(href, "https://duckduckgo.com");
		const uddg = u.searchParams.get("uddg");
		if (uddg) return decodeURIComponent(uddg);
	} catch {
		// keep raw
	}
	return href;
}

async function searchDuckDuckGo(query: string, count: number): Promise<{ engine: string; hits: SearchHit[] }> {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);

	const res = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
	const html = await res.text();

	const hits: SearchHit[] = [];
	// Split on result cards when possible
	const cards = html.split(/class="[^"]*web-result[^"]*"/i).slice(1);
	const blocks = cards.length > 0 ? cards : [html];

	for (const block of blocks) {
		if (hits.length >= count) break;
		// skip obvious ads
		if (/result--ad|badge--ad/i.test(block.slice(0, 200)) && !/web-result/.test(block.slice(0, 80))) {
			continue;
		}
		const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!a) continue;
		const snip =
			/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i.exec(block)?.[1] ?? "";
		const href = unwrapDdgHref(a[1]);
		// filter pure ad redirect noise when possible
		if (/ad_provider=|bing\.com\/aclick/i.test(href)) continue;
		hits.push({
			title: decodeBasicEntities(a[2]),
			url: href,
			snippet: decodeBasicEntities(snip),
		});
	}

	return { engine: "duckduckgo-html", hits };
}

function formatHits(engine: string, query: string, hits: SearchHit[]): string {
	if (hits.length === 0) {
		return `No results for ${JSON.stringify(query)} via ${engine}.`;
	}
	const lines = [`Search engine: ${engine}`, `Query: ${query}`, ""];
	hits.forEach((h, i) => {
		lines.push(`${i + 1}. ${h.title}`);
		lines.push(`   ${h.url}`);
		if (h.snippet) lines.push(`   ${h.snippet}`);
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

export default function webToolsExtension(pi: ExtensionAPI) {
	// Ensure search/pdf + common read tools are available without wiping user toggles.
	pi.on("session_start", async () => {
		const active = new Set(pi.getActiveTools());
		for (const name of ["grep", "find", "ls", "google_search", "pdf", "subagent"]) {
			active.add(name);
		}
		pi.setActiveTools([...active]);
	});

	pi.registerTool({
		name: "google_search",
		promptSnippet: "Web search (Google/Brave/DDG)",
		label: "Search",
		description: "Web search (Google CSE / Brave / DDG).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(
				Type.Number({ description: "Max results (1-10, default 5)", minimum: 1, maximum: 10 }),
			),
			engine: Type.Optional(
				StringEnum(["auto", "google", "brave", "duckduckgo"] as const, {
					description: "Force a backend. Default auto.",
				}),
			),
		}),

		async execute(_id, params) {
			const query = params.query.trim();
			const count = params.count ?? 5;
			const engine = params.engine ?? "auto";
			if (!query) {
				return textResult("Empty query.", { error: "empty_query" });
			}

			const tryOrder: Array<"google" | "brave" | "duckduckgo"> =
				engine === "auto"
					? ["google", "brave", "duckduckgo"]
					: engine === "google"
						? ["google"]
						: engine === "brave"
							? ["brave"]
							: ["duckduckgo"];

			const errors: string[] = [];
			for (const e of tryOrder) {
				try {
					const result =
						e === "google"
							? await searchGoogle(query, count)
							: e === "brave"
								? await searchBrave(query, count)
								: await searchDuckDuckGo(query, count);
					return textResult(formatHits(result.engine, query, result.hits), {
						engine: result.engine,
						query,
						count: result.hits.length,
					});
				} catch (err: any) {
					const msg = err?.message ?? String(err);
					if (msg === "missing_google_keys" || msg === "missing_brave_key") {
						errors.push(`${e}: not configured`);
						continue;
					}
					errors.push(`${e}: ${msg}`);
				}
			}

			return textResult(
				[
					"Search failed.",
					...errors.map((e) => `- ${e}`),
					"",
					"For real Google results, export:",
					"  GOOGLE_API_KEY=...",
					"  GOOGLE_CSE_ID=...   # Programmable Search Engine id",
					"Optional: BRAVE_API_KEY=...",
				].join("\n"),
				{ error: "all_backends_failed", errors },
			);
		},
	});

	pi.registerTool({
		name: "pdf",
		promptSnippet: "PDF info / text extract / render pages",
		label: "PDF",
		description: "PDF: info | text | render (page images).",
		parameters: Type.Object({
			action: StringEnum(["info", "text", "render"] as const, {
				description: "info | text | render",
			}),
			path: Type.String({ description: "Path to PDF file" }),
			fromPage: Type.Optional(Type.Number({ description: "First page (1-based)", minimum: 1 })),
			toPage: Type.Optional(Type.Number({ description: "Last page (1-based)", minimum: 1 })),
			maxChars: Type.Optional(
				Type.Number({
					description: "Max characters for text extract (default 80000)",
					minimum: 1000,
					maximum: 500000,
				}),
			),
			dpi: Type.Optional(
				Type.Number({ description: "Render DPI for render action (default 120)", minimum: 72, maximum: 200 }),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const filePath = params.path.startsWith("/")
				? params.path
				: join(ctx.cwd, params.path);

			try {
				await fs.access(filePath);
			} catch {
				return textResult(`PDF not found: ${filePath}`, { error: "not_found", path: filePath });
			}

			if (params.action === "info") {
				try {
					const { stdout } = await runCmd("pdfinfo", [filePath]);
					return textResult(stdout.trim() || "(no info)", { path: filePath, action: "info" });
				} catch (err: any) {
					return textResult(`pdfinfo failed: ${err.message}`, { error: "pdfinfo_failed" });
				}
			}

			if (params.action === "text") {
				const args = ["-layout", "-enc", "UTF-8"];
				if (params.fromPage) args.push("-f", String(params.fromPage));
				if (params.toPage) args.push("-l", String(params.toPage));
				args.push(filePath, "-");
				try {
					const { stdout } = await runCmd("pdftotext", args, { maxBuffer: 40 * 1024 * 1024 });
					const maxChars = params.maxChars ?? 80_000;
					let text = stdout;
					let clipped = false;
					if (text.length > maxChars) {
						text = text.slice(0, maxChars);
						clipped = true;
					}
					const header = [
						`PDF text: ${filePath}`,
						params.fromPage || params.toPage
							? `pages: ${params.fromPage ?? 1}-${params.toPage ?? "end"}`
							: "pages: all",
						clipped ? `clipped to ${maxChars} chars` : null,
						"",
					]
						.filter((l) => l !== null)
						.join("\n");
					return textResult(header + text, {
						path: filePath,
						action: "text",
						clipped,
					});
				} catch (err: any) {
					return textResult(`pdftotext failed: ${err.message}`, { error: "pdftotext_failed" });
				}
			}

			// render pages to images
			const from = params.fromPage ?? 1;
			const to = params.toPage ?? from;
			if (to < from) {
				return textResult("toPage must be >= fromPage", { error: "bad_range" });
			}
			if (to - from > 4) {
				return textResult("Render at most 5 pages at a time (narrow fromPage/toPage).", {
					error: "too_many_pages",
				});
			}

			const dpi = params.dpi ?? 120;
			const dir = await fs.mkdtemp(join(tmpdir(), "pi-pdf-"));
			const prefix = join(dir, "page");
			try {
				await runCmd(
					"pdftoppm",
					["-png", "-r", String(dpi), "-f", String(from), "-l", String(to), filePath, prefix],
					{ timeout: 120_000 },
				);

				const files = (await fs.readdir(dir))
					.filter((f) => f.endsWith(".png"))
					.sort();

				if (files.length === 0) {
					return textResult("pdftoppm produced no images.", { error: "no_images" });
				}

				const content: Content[] = [
					{
						type: "text",
						text: `Rendered PDF pages ${from}-${to} from ${filePath} at ${dpi} DPI (${files.length} image(s)).`,
					},
				];

				for (const f of files) {
					const buf = await fs.readFile(join(dir, f));
					// keep individual images reasonable
					if (buf.byteLength > 4 * 1024 * 1024) {
						content.push({
							type: "text",
							text: `Skipped ${f} (${formatSize(buf.byteLength)} > 4MB). Re-render at lower dpi.`,
						});
						continue;
					}
					content.push({
						type: "image",
						source: {
							type: "base64",
							mediaType: "image/png",
							data: buf.toString("base64"),
						},
					});
				}

				return {
					content,
					details: { path: filePath, action: "render", from, to, dpi, pages: files.length },
				};
			} catch (err: any) {
				return textResult(`pdftoppm failed: ${err.message}`, { error: "pdftoppm_failed" });
			} finally {
				await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});
}
