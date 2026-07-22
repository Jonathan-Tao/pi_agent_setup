/**
 * Sudo Tool
 *
 * Explicit elevation tool — the model must call `sudo` (not `bash` with sudo).
 * Prompts for approval + masked password when credentials aren't cached.
 * Uses SUDO_ASKPASS for reliable password delivery (avoids `sudo -S` quirks).
 *
 * - Agent `bash` containing a sudo invocation is blocked with a redirect message.
 * - User `!` shell commands that invoke sudo still get the password prompt.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PASSWORD_ATTEMPTS = 3;

/** True if the shell text would actually invoke the sudo binary. */
function hasSudoInvocation(command: string): boolean {
	// Start of command, or after common shell separators/operators.
	return /(?:^|[\n;&|(`]|\|\||&&)\s*sudo\b/.test(command);
}

function truncateCmd(command: string, max = 120): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

function runSudo(
	args: string[],
	opts: {
		env?: NodeJS.ProcessEnv;
		stdin?: "ignore" | "pipe";
		signal?: AbortSignal;
		password?: string;
	} = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("sudo", args, {
			stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
			env: opts.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		const onAbort = () => {
			child.kill("SIGTERM");
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", (err) => {
			opts.signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? 1, stdout, stderr });
		});
		if (opts.password !== undefined) {
			child.stdin?.on("error", () => {
				/* ignore EPIPE if sudo exits early */
			});
			child.stdin?.end(`${opts.password}\n`);
		}
	});
}

async function hasCachedCredentials(signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await runSudo(["-n", "true"], { signal });
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Validate password and cache the timestamp via SUDO_ASKPASS.
 * Falls back to `sudo -S` if askpass setup fails.
 */
async function sudoValidate(password: string, signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sudo-"));
	const passFile = path.join(dir, "pass");
	const askpass = path.join(dir, "askpass.sh");

	try {
		// Exact password bytes + newline (PAM reads a line)
		fs.writeFileSync(passFile, `${password}\n`, { mode: 0o600 });
		fs.writeFileSync(askpass, `#!/bin/sh\nexec /bin/cat -- ${JSON.stringify(passFile)}\n`, {
			mode: 0o700,
		});

		const env: NodeJS.ProcessEnv = {
			...process.env,
			SUDO_ASKPASS: askpass,
			// Force askpass even if a tty is present
			SUDO_ASKPASS_REQUIRE: "1",
		};

		const result = await runSudo(["-A", "-v"], { env, signal });
		return { code: result.code, stderr: result.stderr };
	} catch {
		// Fallback: stdin password
		const result = await runSudo(["-S", "-v", "-p", ""], {
			stdin: "pipe",
			password,
			signal,
		});
		return { code: result.code, stderr: result.stderr };
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function stripBracketedPaste(data: string): string {
	return data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
}

/** Decode a single kitty keyboard-protocol key if present. */
function decodeKittyKey(data: string): { type: "char"; ch: string } | { type: "special"; name: "enter" | "escape" | "backspace" } | undefined {
	// CSI codepoint ; modifiers u
	const m = data.match(/^\x1b\[(\d+)(?:;(\d+))?u$/);
	if (!m) return undefined;
	const code = Number(m[1]);
	const mods = Number(m[2] ?? "1");
	if (code === 13 || code === 10) return { type: "special", name: "enter" };
	if (code === 27) return { type: "special", name: "escape" };
	if (code === 127 || code === 8) return { type: "special", name: "backspace" };
	// Only unshifted/no-mod printable
	if (mods <= 1 && code >= 32 && code !== 127) {
		try {
			return { type: "char", ch: String.fromCodePoint(code) };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function promptPassword(ctx: ExtensionContext, command: string, attempt: number): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;

	if (ctx.mode !== "tui") {
		const label =
			attempt > 1
				? `sudo password (attempt ${attempt}/${MAX_PASSWORD_ATTEMPTS})`
				: "sudo password";
		return ctx.ui.input(`${label} for: ${truncateCmd(command, 60)}`);
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		let value = "";
		let cachedLines: string[] | undefined;

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const submit = () => done(value);
		const cancel = () => done(undefined);
		const backspace = () => {
			if (value.length > 0) {
				value = value.slice(0, -1);
				refresh();
			}
		};

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const w = Math.max(20, width);
				const bar = theme.fg("accent", "─".repeat(Math.min(w, 72)));
				const lines: string[] = [
					bar,
					theme.fg("warning", theme.bold(" sudo authentication required")),
					"",
					theme.fg("muted", ` $ ${truncateCmd(command, Math.min(w - 3, 100))}`),
					"",
				];
				if (attempt > 1) {
					lines.push(theme.fg("error", ` Incorrect password — attempt ${attempt}/${MAX_PASSWORD_ATTEMPTS}`));
				}
				lines.push(theme.fg("text", ` Password: ${"*".repeat(value.length)}`));
				lines.push("");
				lines.push(theme.fg("dim", " Enter submit · Esc cancel"));
				lines.push(bar);
				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					cancel();
					return;
				}
				if (matchesKey(data, Key.enter) || data === "\n" || data === "\r" || data === "\r\n") {
					submit();
					return;
				}
				if (data === "\x7f" || data === "\b" || matchesKey(data, Key.backspace)) {
					backspace();
					return;
				}
				// Ctrl+U — clear line
				if (data === "\x15") {
					value = "";
					refresh();
					return;
				}

				const kitty = decodeKittyKey(data);
				if (kitty) {
					if (kitty.type === "special") {
						if (kitty.name === "enter") submit();
						else if (kitty.name === "escape") cancel();
						else if (kitty.name === "backspace") backspace();
						return;
					}
					value += kitty.ch;
					refresh();
					return;
				}

				// Bracketed paste (possibly mixed with other text)
				if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
					const chunk = stripBracketedPaste(data).replace(/[\r\n]/g, "");
					// Drop any residual CSI
					const cleaned = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
					if (cleaned) {
						value += cleaned;
						refresh();
					}
					return;
				}

				// Ignore other controls / CSI sequences
				if (data.startsWith("\x1b")) return;
				if (data.charCodeAt(0) < 32) return;

				const chunk = data.replace(/[\r\n]/g, "");
				if (chunk) {
					value += chunk;
					refresh();
				}
			},
		};
	});
}

type EnsureResult = { ok: true } | { ok: false; reason: string };

async function ensureSudoCredentials(
	ctx: ExtensionContext,
	command: string,
	signal?: AbortSignal,
): Promise<EnsureResult> {
	if (await hasCachedCredentials(signal)) {
		return { ok: true };
	}

	if (!ctx.hasUI) {
		return {
			ok: false,
			reason:
				"sudo needs a password but no UI is available (non-interactive mode). Run a sudo command yourself first, or use TUI mode.",
		};
	}

	const allowed = await ctx.ui.confirm(
		"sudo",
		`Allow elevated command?\n\n$ ${truncateCmd(command, 200)}`,
	);
	if (!allowed) {
		return { ok: false, reason: "User denied sudo" };
	}

	for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
		if (signal?.aborted) {
			return { ok: false, reason: "Aborted" };
		}

		const password = await promptPassword(ctx, command, attempt);
		if (password === undefined) {
			return { ok: false, reason: "User cancelled sudo password prompt" };
		}
		if (password.length === 0) {
			if (attempt >= MAX_PASSWORD_ATTEMPTS) {
				return { ok: false, reason: "sudo authentication failed (empty password)" };
			}
			continue;
		}

		try {
			const result = await sudoValidate(password, signal);

			if (result.code === 0) {
				ctx.ui.notify("sudo: credentials cached", "info");
				return { ok: true };
			}

			const err = result.stderr.trim();
			if (attempt >= MAX_PASSWORD_ATTEMPTS) {
				return {
					ok: false,
					reason: err
						? `sudo authentication failed: ${err}`
						: "sudo authentication failed (too many attempts)",
				};
			}
		} catch (err) {
			return {
				ok: false,
				reason: `sudo failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return { ok: false, reason: "sudo authentication failed" };
}

export default function sudoExtension(pi: ExtensionAPI) {
	// Agent must use the sudo tool — don't silently elevate via bash.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: string }).command ?? "");
		if (!hasSudoInvocation(command)) return undefined;

		return {
			block: true,
			reason:
				"Do not run sudo via the bash tool. Call the `sudo` tool instead and pass the command without a leading sudo.",
		};
	});

	// User ! / !! shell commands that invoke sudo still get a password prompt.
	pi.on("user_bash", async (event, ctx) => {
		if (!hasSudoInvocation(event.command)) return undefined;

		const result = await ensureSudoCredentials(ctx, event.command, ctx.signal);
		if (!result.ok) {
			return {
				result: {
					output: result.reason,
					exitCode: 1,
					cancelled: result.reason.includes("cancel") || result.reason.includes("denied"),
					truncated: false,
				},
			};
		}
		return undefined;
	});

	pi.registerTool({
		name: "sudo",
		label: "sudo",
		description:
			"Run a shell command with sudo (root privileges). Prompts the user to approve and enter their password if needed. Prefer this over bash when the command requires elevation.",
		promptSnippet: "Run a command with sudo (prompts user; no leading sudo in command)",
		promptGuidelines: [
			"Use the sudo tool for elevation — never bash with sudo. Pass command without a leading sudo.",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to run under sudo (without a leading sudo)",
			}),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const raw = params.command.trim();
			if (!raw) {
				return {
					content: [{ type: "text", text: "Error: empty command" }],
					details: { exitCode: 1 },
					isError: true,
				};
			}

			// Avoid double-sudo if the model includes it anyway
			const stripped = raw.replace(/^sudo\s+/, "");
			const display = `sudo ${stripped}`;

			const ensured = await ensureSudoCredentials(ctx, display, signal);
			if (!ensured.ok) {
				return {
					content: [{ type: "text", text: ensured.reason }],
					details: { exitCode: 1, denied: true },
					isError: true,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `$ ${display}\n` }] });

			const timeoutMs =
				params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0
					? params.timeout * 1000
					: undefined;

			const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
				// -n: never prompt (credentials already cached); fail clearly if not
				const child = spawn("sudo", ["-n", "--", "bash", "-lc", stripped], {
					cwd: ctx.cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
					detached: process.platform !== "win32",
				});

				let output = "";
				const append = (d: Buffer) => {
					output += d.toString();
					onUpdate?.({ content: [{ type: "text", text: `$ ${display}\n${output}` }] });
				};
				child.stdout?.on("data", append);
				child.stderr?.on("data", append);

				let timedOut = false;
				const timer =
					timeoutMs !== undefined
						? setTimeout(() => {
								timedOut = true;
								if (child.pid) {
									try {
										process.kill(-child.pid, "SIGTERM");
									} catch {
										child.kill("SIGTERM");
									}
								}
							}, timeoutMs)
						: undefined;

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGTERM");
						} catch {
							child.kill("SIGTERM");
						}
					}
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				child.on("error", (err) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(err);
				});
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						reject(new Error("Command aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`Command timed out after ${params.timeout} seconds`));
						return;
					}
					resolve({ code: code ?? 1, output });
				});
			}).catch((err: Error) => ({ code: 1, output: err.message }));

			const truncation = truncateTail(result.output || "(no output)", {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines]`;
			}
			if (result.code !== 0) {
				text += `\n\nCommand exited with code ${result.code}`;
			}

			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.code, command: display },
				isError: result.code !== 0,
			};
		},

		renderCall(args, theme) {
			const cmd = typeof args.command === "string" ? args.command.replace(/^sudo\s+/, "") : "...";
			return new Text(theme.fg("toolTitle", theme.bold("sudo ")) + theme.fg("warning", cmd), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { exitCode?: number; denied?: boolean } | undefined;
			if (details?.denied) {
				return new Text(theme.fg("warning", "denied"), 0, 0);
			}
			const code = details?.exitCode;
			if (code === 0) {
				return new Text(theme.fg("success", "✓ exit 0"), 0, 0);
			}
			if (typeof code === "number") {
				return new Text(theme.fg("error", `exit ${code}`), 0, 0);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}
