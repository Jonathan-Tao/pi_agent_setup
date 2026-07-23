import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type Artifact, type ArtifactSet, type Component, type Diagnostic, type HardwareIndex, type Net, type ParsedArtifact,
  boundedLimit, buildIndex, cachedText, capabilityMatrix, classifyArtifact, containedPath, discoverArtifacts,
  normalizeLookup, storeCachedText, temporaryRenderDirectory,
} from "./core.ts";

const actions = ["discover", "inspect", "search", "component", "net", "neighbors", "trace", "location", "render", "compare", "check", "status"] as const;
const parameters = Type.Object({
  action: StringEnum(actions),
  root: Type.Optional(Type.String({ description: "Search root relative to cwd; defaults to cwd" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Explicit artifact paths relative to cwd" })),
  setId: Type.Optional(Type.String({ description: "Artifact-set handle returned by discover" })),
  query: Type.Optional(Type.String({ description: "Search text, component reference, or net name" })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  traversePassives: Type.Optional(Type.Boolean({ description: "Traverse known two-terminal R/C/L/FB parts as labeled inference" })),
  maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000 })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  maxMegabytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Maximum total artifact bytes inspected during discovery" })),
});
export type HardwareToolInput = Static<typeof parameters>;

interface Selection { artifacts: Artifact[]; set?: ArtifactSet; discoveryDiagnostics: Diagnostic[] }
interface ExecResult { stdout: string; stderr: string; code: number | null; killed?: boolean }
type Exec = (command: string, args: string[], options: { signal?: AbortSignal; timeout?: number }) => Promise<ExecResult>;

function requireQuery(params: HardwareToolInput, label = "query"): string {
  if (!params.query?.trim()) throw new Error(`${label} is required for ${params.action}`);
  return params.query.trim();
}
function escaped(value: string): string { return JSON.stringify(value); }
function provenance(component: Component): string { return [...new Set(component.provenance.map((item) => `${item.path}${item.line ? `:${item.line}` : ""}`))].join(", "); }
function componentLine(component: Component): string {
  const fields = [component.ref, component.value && `value=${escaped(component.value)}`, component.footprint && `footprint=${escaped(component.footprint)}`, component.x !== undefined && `x=${component.x}`, component.y !== undefined && `y=${component.y}`, component.side && `side=${component.side}`, component.dnp && "DNP", component.pins.length && `pins=${component.pins.length}`].filter(Boolean);
  return `${fields.join(" ")} [${provenance(component)}]`;
}
function netLine(net: Net): string { return `${net.name} (${net.authority}, ${net.pins.length} pins) [${net.provenance.map((item) => item.path).join(", ")}]`; }

function truncate(text: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Output truncated: ${result.outputLines}/${result.totalLines} lines, ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Narrow the query or use pagination.]`;
}
function response(text: string, details: unknown = {}) { return { content: [{ type: "text" as const, text: truncate(text) }], details }; }

async function pdfText(artifact: Artifact, exec: Exec, signal?: AbortSignal): Promise<string> {
  const cached = await cachedText(artifact); if (cached !== undefined) return cached;
  const result = await exec("pdftotext", ["-layout", artifact.absolutePath, "-"], { signal, timeout: 120_000 });
  if (result.code !== 0) throw new Error(`pdftotext failed for ${artifact.path}: ${result.stderr.trim() || "unknown error"}`);
  await storeCachedText(artifact, result.stdout); return result.stdout;
}
async function pdfMetadata(artifact: Artifact, exec: Exec, signal?: AbortSignal): Promise<Record<string, string>> {
  const result = await exec("pdfinfo", [artifact.absolutePath], { signal, timeout: 30_000 });
  if (result.code !== 0) return { error: result.stderr.trim() || "pdfinfo unavailable" };
  return Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => line.match(/^([^:]+):\s*(.*)$/)).filter((item): item is RegExpMatchArray => item !== null).map((item) => [item[1].trim(), item[2].trim()]));
}

function pageMatches(text: string, query: string, path: string, limit: number): string[] {
  const needle = query.toLowerCase(), results: string[] = [];
  for (const [index, page] of text.split("\f").entries()) {
    for (const line of page.split(/\r?\n/)) {
      if (line.toLowerCase().includes(needle)) results.push(`${path}:page ${index + 1}: ${line.trim()}`);
      if (results.length >= limit) return results;
    }
  }
  return results;
}
function parsedKinds(parsed: ParsedArtifact[]): string { return [...new Set(parsed.map((item) => item.artifact.kind))].sort().join(", ") || "none"; }

function mergedComponentRecords(index: HardwareIndex, ref: string): Component[] { return index.components.get(normalizeLookup(ref)) ?? []; }
function mergedNetRecords(index: HardwareIndex, name: string): Net[] { return index.nets.get(normalizeLookup(name)) ?? []; }
function pinKey(ref: string, pin: string): string { return `${normalizeLookup(ref)}-${normalizeLookup(pin)}`; }

function comparison(index: HardwareIndex): { lines: string[]; findings: object[] } {
  const schematic = index.parsed.flatMap((item) => item.nets.filter((net) => net.authority === "schematic"));
  const pcb = index.parsed.flatMap((item) => item.nets.filter((net) => net.authority === "pcb"));
  const manufactured = index.parsed.flatMap((item) => item.nets.filter((net) => net.authority === "manufactured"));
  const findings: Array<{ severity: string; category: string; message: string }> = [];
  function compareDomain(label: string, other: Net[]) {
    if (!schematic.length || !other.length) return;
    const schematicPins = new Map(schematic.flatMap((net) => net.pins.map((pin) => [pinKey(pin.ref, pin.pin), net.name] as const)));
    const otherPins = new Map(other.flatMap((net) => net.pins.map((pin) => [pinKey(pin.ref, pin.pin), net.name] as const)));
    for (const [pin, net] of schematicPins) {
      if (!otherPins.has(pin)) findings.push({ severity: "warning", category: label, message: `${pin} is on schematic net ${net} but absent from ${label}` });
      else if (normalizeLookup(otherPins.get(pin)!) !== normalizeLookup(net)) findings.push({ severity: "error", category: label, message: `${pin}: schematic=${net}, ${label}=${otherPins.get(pin)}` });
    }
    for (const [pin, net] of otherPins) if (!schematicPins.has(pin)) findings.push({ severity: "warning", category: label, message: `${pin} is on ${label} net ${net} but absent from schematic connectivity` });
  }
  compareDomain("PCB", pcb); compareDomain("IPC-D-356", manufactured);
  const bomRefs = new Set(index.parsed.filter((item) => item.artifact.kind === "bom").flatMap((item) => item.components.map((component) => normalizeLookup(component.ref))));
  const placementRefs = new Set(index.parsed.filter((item) => item.artifact.kind === "placement").flatMap((item) => item.components.map((component) => normalizeLookup(component.ref))));
  if (bomRefs.size && placementRefs.size) {
    for (const ref of bomRefs) if (!placementRefs.has(ref)) findings.push({ severity: "warning", category: "assembly", message: `${ref} is in BOM but absent from placement` });
    for (const ref of placementRefs) if (!bomRefs.has(ref)) findings.push({ severity: "warning", category: "assembly", message: `${ref} is placed but absent from BOM` });
  }
  const lines = findings.length ? findings.map((item) => `${item.severity.toUpperCase()} ${item.category}: ${item.message}`) : ["No cross-artifact conflicts found in represented data."];
  if (!schematic.length) lines.unshift("Logical comparison unavailable: no parsed schematic netlist.");
  if (!pcb.length && !manufactured.length) lines.unshift("PCB comparison unavailable: no parsed semantic PCB or IPC-D-356 connectivity.");
  return { lines, findings };
}

function checks(index: HardwareIndex): { lines: string[]; findings: object[] } {
  const findings: Array<{ severity: string; check: string; message: string; paths?: string[] }> = [];
  for (const [ref, records] of index.components) {
    const factRecords = records.filter((record) => record.provenance.some((item) => item.evidence === "fact"));
    const perSource = new Map<string, number>();
    for (const record of factRecords) for (const source of new Set(record.provenance.map((item) => item.path))) perSource.set(source, (perSource.get(source) ?? 0) + 1);
    for (const [source, count] of perSource) if (count > 1) findings.push({ severity: "error", check: "duplicate-reference", message: `${ref} appears ${count} times in ${source}` });
    const values = new Set(records.map((item) => item.value).filter(Boolean)); if (values.size > 1) findings.push({ severity: "warning", check: "conflicting-value", message: `${ref} has conflicting values: ${[...values].join(", ")}` });
    const footprints = new Set(records.map((item) => item.footprint).filter(Boolean)); if (footprints.size > 1) findings.push({ severity: "warning", check: "conflicting-footprint", message: `${ref} has conflicting footprints: ${[...footprints].join(", ")}` });
  }
  for (const item of index.parsed) for (const net of item.nets) {
    if (!net.name.trim()) findings.push({ severity: "error", check: "unnamed-net", message: `Unnamed ${net.authority} net in ${item.artifact.path}` });
    for (const pin of net.pins) if (!pin.ref.trim() || !pin.pin.trim()) findings.push({ severity: "error", check: "malformed-pin", message: `Malformed pin on net ${net.name} in ${item.artifact.path}` });
  }
  const gerbers = index.parsed.filter((item) => item.artifact.kind === "gerber"); const drills = index.parsed.filter((item) => item.artifact.kind === "drill");
  if (drills.length && !gerbers.length) findings.push({ severity: "warning", check: "orphan-drill", message: "Drill data is present without detected Gerber layers" });
  const bom = index.parsed.filter((item) => item.artifact.kind === "bom").flatMap((item) => item.components);
  const placed = new Set(index.parsed.filter((item) => item.artifact.kind === "placement").flatMap((item) => item.components.map((component) => normalizeLookup(component.ref))));
  for (const component of bom) if (component.dnp && placed.has(normalizeLookup(component.ref))) findings.push({ severity: "warning", check: "placed-dnp", message: `${component.ref} is marked DNP but appears in placement` });
  const schematicPins = new Map(index.parsed.flatMap((item) => item.nets.filter((net) => net.authority === "schematic").flatMap((net) => net.pins.map((pin) => [pinKey(pin.ref, pin.pin), net.name] as const))));
  for (const item of index.parsed) if (item.intent) {
    for (const expectation of item.intent.requiredConnections) {
      const actual = schematicPins.get(pinKey(expectation.ref, expectation.pin));
      if (actual === undefined) findings.push({ severity: "error", check: "required-connection", message: `${expectation.ref}.${expectation.pin} must connect to ${expectation.net}, but the pin is absent from schematic connectivity` });
      else if (normalizeLookup(actual) !== normalizeLookup(expectation.net)) findings.push({ severity: "error", check: "required-connection", message: `${expectation.ref}.${expectation.pin} must connect to ${expectation.net}, actual=${actual}` });
    }
    for (const expectation of item.intent.forbiddenConnections) {
      const actual = schematicPins.get(pinKey(expectation.ref, expectation.pin));
      if (actual !== undefined && normalizeLookup(actual) === normalizeLookup(expectation.net)) findings.push({ severity: "error", check: "forbidden-connection", message: `${expectation.ref}.${expectation.pin} is forbidden from ${expectation.net}` });
    }
  }
  const compared = comparison(index);
  for (const finding of compared.findings as Array<{ severity: string; category: string; message: string }>) findings.push({ severity: finding.severity, check: `compare-${finding.category}`, message: finding.message });
  const lines = findings.length ? findings.map((item) => `${item.severity.toUpperCase()} ${item.check}: ${item.message}`) : ["No deterministic violations found in represented data."];
  return { lines, findings };
}

function trace(index: HardwareIndex, start: string, maxDepth: number, traversePassives: boolean, limit: number): { lines: string[]; inferred: boolean } {
  const startKey = normalizeLookup(start); const records = index.components.get(startKey); if (!records?.length) return { lines: [`Component not found: ${start}`], inferred: false };
  const queue: Array<{ ref: string; depth: number }> = [{ ref: startKey, depth: 0 }]; const seen = new Set<string>(); const lines: string[] = []; let inferred = false;
  while (queue.length && lines.length < limit) {
    const current = queue.shift()!; if (seen.has(current.ref)) continue; seen.add(current.ref);
    for (const component of index.components.get(current.ref) ?? []) for (const pin of component.pins) {
      for (const net of mergedNetRecords(index, pin.net).filter((item) => item.authority === "schematic")) {
        for (const neighbor of net.pins) {
          lines.push(`${current.depth}: ${component.ref}.${pin.pin} -- ${net.name} --> ${neighbor.ref}.${neighbor.pin}`);
          const neighborKey = normalizeLookup(neighbor.ref); const passive = /^(?:R|C|L|FB)\d/i.test(neighbor.ref);
          if (current.depth + 1 < maxDepth && traversePassives && passive) { const neighborRecords = index.components.get(neighborKey) ?? []; if (new Set(neighborRecords.flatMap((item) => item.pins.map((item) => item.net))).size === 2) { queue.push({ ref: neighborKey, depth: current.depth + 1 }); inferred = true; } }
          if (lines.length >= limit) break;
        }
      }
    }
  }
  if (inferred) lines.unshift("INFERENCE: traversal crossed explicitly identified two-terminal R/C/L/FB components; internal connectivity was not a netlist fact.");
  return { lines, inferred };
}

export default function hardwareExtension(pi: ExtensionAPI) {
  const discoveredSets = new Map<string, { cwd: string; set: ArtifactSet; artifacts: Artifact[] }>();
  const indexes = new Map<string, HardwareIndex>();
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  async function classifyExplicit(cwd: string, paths: string[]): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    for (const input of paths) {
      const absolutePath = await containedPath(cwd, input, true); const details = await stat(absolutePath); const full = await readFile(absolutePath); const classified = classifyArtifact(relative(cwd, absolutePath), full.subarray(0, 256 * 1024));
      artifacts.push({ path: relative(cwd, absolutePath).replaceAll("\\", "/"), absolutePath, ...classified, size: details.size, mtimeMs: details.mtimeMs, hash: (await import("node:crypto")).createHash("sha256").update(full).digest("hex"), diagnostics: classified.kind === "unknown" ? [{ severity: "warning", message: "Unsupported or unrecognized artifact", path: relative(cwd, absolutePath) }] : [] });
    }
    return artifacts;
  }

  async function selection(params: HardwareToolInput, cwd: string, signal?: AbortSignal): Promise<Selection> {
    if (params.paths?.length) return { artifacts: await classifyExplicit(cwd, params.paths), discoveryDiagnostics: [] };
    if (params.setId) {
      const remembered = discoveredSets.get(params.setId); if (!remembered || remembered.cwd !== cwd) throw new Error(`Unknown artifact set for this working directory: ${params.setId}`);
      return { artifacts: remembered.artifacts, set: remembered.set, discoveryDiagnostics: [] };
    }
    const discovery = await discoverArtifacts(cwd, params.root ?? ".", { maxFiles: params.maxFiles, maxDepth: params.maxDepth, maxTotalBytes: params.maxMegabytes === undefined ? undefined : params.maxMegabytes * 1024 * 1024, signal });
    return { artifacts: discovery.artifacts, discoveryDiagnostics: discovery.diagnostics };
  }
  async function indexFor(selected: Selection): Promise<HardwareIndex> {
    const key = selected.artifacts.map((artifact) => `${artifact.path}:${artifact.hash}`).sort().join("|"); const cached = indexes.get(key); if (cached) return cached;
    const index = await buildIndex(selected.artifacts); indexes.set(key, index); return index;
  }

  pi.registerTool({
    name: "hardware",
    label: "Hardware Artifacts",
    description: "Find and inspect hardware design artifacts for hardware questions, design review, and bug triage.",
    promptSnippet: "Find and inspect hardware design artifacts",
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Hardware operation cancelled");
      const limit = boundedLimit(params.limit), offset = params.offset ?? 0;
      if (params.action === "discover") {
        onUpdate?.({ content: [{ type: "text", text: `Discovering hardware artifacts beneath ${params.root ?? "."}…` }] });
        const result = await discoverArtifacts(ctx.cwd, params.root ?? ".", { maxFiles: params.maxFiles, maxDepth: params.maxDepth, maxTotalBytes: params.maxMegabytes === undefined ? undefined : params.maxMegabytes * 1024 * 1024, signal });
        for (const set of result.sets) discoveredSets.set(set.id, { cwd: ctx.cwd, set, artifacts: result.artifacts.filter((artifact) => set.paths.includes(artifact.path)) });
        const visible = result.artifacts.slice(offset, offset + limit); const lines = [`Root: ${result.root}`, `Artifacts: ${result.artifacts.length}${result.truncated ? " (discovery truncated)" : ""}`, ...visible.map((artifact) => `${artifact.kind}\t${artifact.path}\tconfidence=${artifact.confidence.toFixed(2)}\t${artifact.evidence.join("; ")}`)];
        if (offset + visible.length < result.artifacts.length) lines.push(`[Results truncated: showing ${offset + 1}-${offset + visible.length} of ${result.artifacts.length}; increase offset or limit.]`);
        if (result.sets.length) lines.push("Artifact sets:", ...result.sets.map((set) => `${set.id}\t${set.paths.length} files\t${set.ambiguous ? "AMBIGUOUS; select explicit paths" : set.reason}`));
        if (result.diagnostics.length) lines.push("Diagnostics:", ...result.diagnostics.map((item) => `${item.severity.toUpperCase()}: ${item.path ?? ""} ${item.message}`));
        return response(lines.join("\n"), result);
      }

      const selected = await selection(params, ctx.cwd, signal); if (!selected.artifacts.length) return response("No recognized hardware artifacts selected.", { capabilities: capabilityMatrix([]) });
      const index = await indexFor(selected);
      if (params.action === "inspect" || params.action === "status") {
        const capabilities = capabilityMatrix(index.parsed); const lines = [`Artifacts (${selected.artifacts.length}):`, ...index.parsed.map((item) => `${item.artifact.kind}\t${item.artifact.path}\tcomponents=${item.components.length}\tnets=${item.nets.length}${item.geometry ? `\tfeatures=${item.geometry.features}` : ""}`), "Capabilities:", ...Object.entries(capabilities).map(([name, state]) => `${name}: ${state}`)];
        const diagnostics = [...selected.discoveryDiagnostics, ...selected.artifacts.flatMap((artifact) => artifact.diagnostics), ...index.diagnostics];
        if (diagnostics.length) lines.push("Diagnostics:", ...diagnostics.map((item) => `${item.severity.toUpperCase()}: ${item.path ?? ""}${item.line ? `:${item.line}` : ""} ${item.message}`));
        if (capabilities.logicalConnectivity === "absent") lines.push("Logical connectivity unavailable: provide an exported schematic netlist; PDF content is not used to invent connections.");
        if (capabilities.semanticLayout === "absent") lines.push("Semantic layout unavailable: provide a validated IPC-2581 or other supported semantic PCB export.");
        for (const pdf of selected.artifacts.filter((artifact) => artifact.kind === "pdf")) lines.push(`PDF ${pdf.path}: ${JSON.stringify(await pdfMetadata(pdf, exec, signal))}`);
        return response(lines.join("\n"), { capabilities, diagnostics, kinds: parsedKinds(index.parsed) });
      }
      if (params.action === "search") {
        const query = requireQuery(params); const needle = query.toLowerCase(); const lines: string[] = [];
        for (const [ref, records] of index.components) if (ref.toLowerCase().includes(needle) || records.some((record) => `${record.value ?? ""} ${record.footprint ?? ""} ${record.description ?? ""}`.toLowerCase().includes(needle))) for (const record of records) lines.push(`component: ${componentLine(record)}`);
        for (const records of index.nets.values()) for (const net of records) if (net.name.toLowerCase().includes(needle)) lines.push(`net: ${netLine(net)}`);
        for (const pdf of selected.artifacts.filter((artifact) => artifact.kind === "pdf")) { try { lines.push(...pageMatches(await pdfText(pdf, exec, signal), query, pdf.path, limit)); } catch (error) { lines.push(`WARNING ${pdf.path}: ${error instanceof Error ? error.message : String(error)}`); } }
        const visible = lines.slice(offset, offset + limit); if (offset + visible.length < lines.length) visible.push(`[Results truncated: showing ${offset + 1}-${offset + visible.length} of ${lines.length}.]`);
        return response(visible.length ? visible.join("\n") : `No matches for ${escaped(query)}.`, { count: lines.length, offset, limit });
      }
      if (params.action === "component") {
        const query = requireQuery(params, "component reference"); const records = mergedComponentRecords(index, query); if (!records.length) return response(`Component not present in parsed exports: ${query}`);
        const lines = records.map(componentLine); for (const record of records) for (const pin of record.pins) lines.push(`  pin ${pin.pin}: ${pin.net} [${pin.provenance.path}${pin.provenance.line ? `:${pin.provenance.line}` : ""}]`);
        return response(lines.join("\n"), { records });
      }
      if (params.action === "net") {
        const query = requireQuery(params, "net name"); const records = mergedNetRecords(index, query); if (!records.length) return response(`Net not present in parsed connectivity exports: ${query}`);
        const lines: string[] = []; for (const net of records) { lines.push(netLine(net)); lines.push(...net.pins.slice(offset, offset + limit).map((pin) => `  ${pin.ref}.${pin.pin} [${pin.provenance.path}${pin.provenance.line ? `:${pin.provenance.line}` : ""}]`)); if (offset + limit < net.pins.length) lines.push(`  [Pin list truncated; offset=${offset}, total=${net.pins.length}]`); }
        return response(lines.join("\n"), { records });
      }
      if (params.action === "neighbors" || params.action === "trace") {
        const query = requireQuery(params, "component reference"); const result = trace(index, query, params.action === "neighbors" ? 1 : params.depth ?? 3, params.traversePassives === true, limit);
        return response(result.lines.join("\n"), result);
      }
      if (params.action === "location") {
        const query = requireQuery(params); const records = mergedComponentRecords(index, query); const lines = records.filter((item) => item.x !== undefined || item.y !== undefined).map((item) => `${item.ref}: x=${item.x ?? "unknown"}, y=${item.y ?? "unknown"}, rotation=${item.rotation ?? "unknown"}, side=${item.side ?? "unknown"} [${provenance(item)}]`);
        return response(lines.length ? lines.join("\n") : `No explicit location represented for ${query}.`, { records });
      }
      if (params.action === "compare") { const result = comparison(index); return response(result.lines.slice(offset, offset + limit).join("\n"), result); }
      if (params.action === "check") { const result = checks(index); return response(result.lines.slice(offset, offset + limit).join("\n"), result); }
      if (params.action === "render") {
        const page = params.page ?? 1; const candidates = selected.artifacts.filter((artifact) => artifact.kind === "pdf" || artifact.kind === "gerber"); if (!candidates.length) return response("No renderable PDF or Gerber artifact selected.");
        const artifact = params.query ? candidates.find((item) => item.path.toLowerCase().includes(params.query!.toLowerCase())) : candidates[0]; if (!artifact) return response(`No renderable artifact matches ${escaped(params.query!)}.`);
        const directory = await temporaryRenderDirectory(); const output = join(directory, "render");
        let result: ExecResult, imagePath: string;
        if (artifact.kind === "pdf") { result = await exec("pdftoppm", ["-f", String(page), "-singlefile", "-png", "-r", "120", artifact.absolutePath, output], { signal, timeout: 120_000 }); imagePath = `${output}.png`; }
        else { result = await exec("gerbv", ["-x", "png", "-o", `${output}.png`, artifact.absolutePath], { signal, timeout: 120_000 }); imagePath = `${output}.png`; }
        if (result.code !== 0) throw new Error(`Rendering failed (${artifact.kind === "pdf" ? "pdftoppm" : "gerbv"}): ${result.stderr.trim() || "renderer unavailable"}`);
        const data = (await readFile(imagePath)).toString("base64");
        return { content: [{ type: "text", text: `${artifact.path}${artifact.kind === "pdf" ? ` page ${page}` : ""}\nVisual/render evidence only; not connectivity evidence.` }, { type: "image", data, mimeType: "image/png" }], details: { path: artifact.path, page, imagePath, evidence: "visual-hint" } };
      }
      throw new Error(`Unsupported hardware action: ${params.action}`);
    },
  });

  // Custom tools are active by default. Keep hardware out of the default prompt;
  // the later-loaded preset extension enables it explicitly for IEM-Firmware.
  pi.on("session_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "hardware"));
  });
}
