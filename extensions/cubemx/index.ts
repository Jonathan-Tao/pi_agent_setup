import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { relative } from "node:path";
import { readIoc, patchIoc, serializeIoc, writeIoc } from "./ioc.ts";
import {
  containedPath,
  discoverExecutable,
  discoverIocFiles,
  followUpCommands,
  generateIsolated,
  hashFile,
  inspectIoc,
  queryIoc,
  runCubeMx,
  cubeScript,
  versionWarnings,
} from "./core.ts";

const actionSchema = StringEnum(["discover", "inspect", "query", "patch", "validate", "generate"] as const);
const parameters = Type.Object({
  action: actionSchema,
  path: Type.Optional(Type.String({ description: "IOC path relative to the working directory" })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Exact raw property keys" })),
  prefix: Type.Optional(Type.String({ description: "Raw property-key prefix" })),
  operations: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ description: "Exact raw property key, including CubeMX escaping" }),
    value: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
  }))),
  apply: Type.Optional(Type.Boolean({ description: "Apply a patch after previewing it; defaults false" })),
  preview: Type.Optional(Type.Boolean({ description: "Generate only in a temporary copy; defaults true" })),
  allowVersionMismatch: Type.Optional(Type.Boolean({ description: "Explicitly permit generation with a different CubeMX/DB version" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 900 })),
});

export type CubeMxToolInput = Static<typeof parameters>;

function requirePath(path: string | undefined): string {
  if (!path) throw new Error("path is required for this action");
  return path;
}

function truncateLog(output: string): string {
  const truncated = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Log truncated: ${truncated.outputLines}/${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)}/${formatSize(truncated.totalBytes)}]`;
}

function formatChanges(changes: Array<{ key: string; before?: string; after?: string }>): string {
  if (!changes.length) return "No property changes.";
  return changes.map((change) => `${change.key}: ${change.before === undefined ? "(missing)" : JSON.stringify(change.before)} -> ${change.after === undefined ? "(removed)" : JSON.stringify(change.after)}`).join("\n");
}

function cubeOutput(result: { stdout: string; stderr: string }): string {
  return truncateLog([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

export default function cubemxExtension(pi: ExtensionAPI) {
  const validated = new Map<string, string>();

  pi.registerTool({
    name: "cubemx",
    label: "STM32CubeMX",
    description: "Discover, inspect, query, losslessly patch, validate, and safely generate STM32 CubeMX .ioc projects. Patch previews by default; generation previews in an isolated copy by default. CubeMX is the semantic authority.",
    promptSnippet: "Inspect, query, losslessly patch, validate, and safely generate STM32CubeMX .ioc projects",
    promptGuidelines: [
      "For any CubeMX-generated code changes, update the .ioc with cubemx and regenerate; never make fragile manual edits to generated code.",
      "For STM32 .ioc changes, use cubemx to inspect and query exact properties before patching, then preview the patch before applying it.",
      "After cubemx patches an .ioc file, validate that exact content and preview generation before applying generation.",
      "Treat CubeMX as the semantic authority; do not use cubemx allowVersionMismatch without explicit user approval.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("CubeMX operation cancelled");
      if (params.action === "discover") {
        const files = await discoverIocFiles(ctx.cwd);
        return { content: [{ type: "text", text: files.length ? files.join("\n") : "No .ioc files found." }], details: { files } };
      }

      const path = await containedPath(ctx.cwd, requirePath(params.path), ".ioc");
      const displayPath = relative(ctx.cwd, path);
      if (params.action === "inspect") {
        const document = await readIoc(path);
        return { content: [{ type: "text", text: `${displayPath}\n${inspectIoc(document)}` }], details: { path: displayPath } };
      }
      if (params.action === "query") {
        if (!(params.keys?.length) && params.prefix === undefined) throw new Error("query requires keys or prefix");
        const matches = queryIoc(await readIoc(path), params.keys ?? [], params.prefix);
        const text = matches.length ? matches.map(([key, value]) => `${key}=${value}`).join("\n") : "No matching properties.";
        return { content: [{ type: "text", text }], details: { path: displayPath, count: matches.length } };
      }
      if (params.action === "patch") {
        if (!params.operations?.length) throw new Error("patch requires at least one operation");
        return withFileMutationQueue(path, async () => {
          const document = await readIoc(path);
          const before = serializeIoc(document);
          const changes = patchIoc(document, params.operations ?? []);
          const after = serializeIoc(document);
          if (params.apply && before !== after) {
            await writeIoc(path, document);
            validated.delete(path);
          }
          const mode = params.apply ? "Applied" : "Preview only (call again with apply=true to write)";
          return { content: [{ type: "text", text: `${mode}: ${displayPath}\n${formatChanges(changes)}` }], details: { path: displayPath, applied: params.apply === true, changes } };
        });
      }

      const executable = await discoverExecutable();
      if (!executable) throw new Error("STM32CubeMX is unavailable. Install it from STMicroelectronics, then set STM32CUBEMX_PATH to its executable or add stm32cubemx to PATH.");
      const document = await readIoc(path);
      const warnings = await versionWarnings(document, executable);
      const timeout = (params.timeoutSeconds ?? (params.action === "generate" ? 300 : 120)) * 1000;
      if (params.action === "validate") {
        onUpdate?.({ content: [{ type: "text", text: `Loading ${displayPath} with CubeMX…` }] });
        const result = await runCubeMx(executable, cubeScript(path), (command, args, options) => pi.exec(command, args, options), signal, timeout);
        if (!result.ok) throw Object.assign(new Error(`CubeMX rejected ${displayPath}.\n${cubeOutput(result)}`), { details: { warnings, result } });
        validated.set(path, await hashFile(path));
        const warningText = warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
        return { content: [{ type: "text", text: `CubeMX validated ${displayPath}.${warningText}\n${cubeOutput(result)}` }], details: { path: displayPath, executable, warnings } };
      }

      if (warnings.length && !params.allowVersionMismatch) {
        throw new Error(`Generation blocked due to version/package mismatch. Validate with the matching CubeMX installation, or explicitly set allowVersionMismatch=true after reviewing:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
      }
      const currentHash = await hashFile(path);
      if (validated.get(path) !== currentHash) throw new Error("Validate this exact .ioc content with cubemx action=validate before generation.");
      const preview = params.preview !== false;
      onUpdate?.({ content: [{ type: "text", text: `${preview ? "Preview-generating" : "Generating"} ${displayPath}…` }] });
      const generated = await generateIsolated(path, executable, (command, args, options) => pi.exec(command, args, options), { preview, signal, timeout });
      if (!preview) validated.set(path, await hashFile(path));
      const changes = generated.changes.map((change) => `${change.status}\t${change.path}`).join("\n") || "No generated file changes.";
      const followUps = followUpCommands(ctx.cwd, path);
      const next = followUps.length ? `\nFollow-up (not executed):\n${followUps.join("\n")}` : "";
      return {
        content: [{ type: "text", text: `${preview ? "Preview" : "Applied"} generation for ${displayPath}:\n${changes}${next}\n${cubeOutput(generated.result)}` }],
        details: { path: displayPath, preview, warnings, changes: generated.changes, followUps },
      };
    },
  });
}
