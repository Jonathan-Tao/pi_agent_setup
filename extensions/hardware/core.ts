import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const PARSER_VERSION = "1";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_SNIFF_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".cache", ".idea", ".vscode", "node_modules", "bazel-bin", "bazel-out", "bazel-testlogs", "dist", "build"]);

export type ArtifactKind = "pdf" | "schematic-netlist" | "bom" | "placement" | "ipc-d-356" | "gerber" | "drill" | "ipc-2581" | "odb++" | "cubemx" | "manifest" | "unknown";
export type Capability = "visualSchematic" | "logicalConnectivity" | "partMetadata" | "assemblyPlacement" | "fabricationGeometry" | "manufacturedConnectivity" | "semanticLayout" | "designIntent";
export type CapabilityState = "available" | "experimental" | "absent" | "unsupported" | "parse-failed";

export interface Diagnostic { severity: "info" | "warning" | "error"; message: string; path?: string; line?: number }
export interface Artifact {
  path: string;
  absolutePath: string;
  kind: ArtifactKind;
  confidence: number;
  parser: string;
  size: number;
  mtimeMs: number;
  hash: string;
  evidence: string[];
  diagnostics: Diagnostic[];
}
export interface ArtifactSet { id: string; paths: string[]; reason: string; ambiguous: boolean }
export interface DiscoveryResult { root: string; artifacts: Artifact[]; sets: ArtifactSet[]; diagnostics: Diagnostic[]; truncated: boolean }
export interface Provenance { path: string; parser: string; line?: number; evidence: "fact" | "visual-hint" | "metadata" | "inference" }
export interface Pin { ref: string; pin: string; net: string; provenance: Provenance }
export interface Component {
  ref: string;
  value?: string;
  footprint?: string;
  description?: string;
  pins: Pin[];
  x?: number;
  y?: number;
  rotation?: number;
  side?: string;
  dnp?: boolean;
  provenance: Provenance[];
}
export interface Net { name: string; pins: Pin[]; authority: "schematic" | "pcb" | "manufactured"; provenance: Provenance[] }
export interface GeometrySummary { kind: "gerber" | "drill"; units?: string; format?: string; features: number; tools: number; provenance: Provenance }
export interface ConnectionExpectation { ref: string; pin: string; net: string; note?: string }
export interface DesignIntent { requiredConnections: ConnectionExpectation[]; forbiddenConnections: ConnectionExpectation[] }
export interface ParsedArtifact {
  artifact: Artifact;
  components: Component[];
  nets: Net[];
  text?: string;
  pages?: number;
  geometry?: GeometrySummary;
  intent?: DesignIntent;
  diagnostics: Diagnostic[];
  metadata: Record<string, string | number | boolean>;
}
export interface HardwareIndex {
  parsed: ParsedArtifact[];
  components: Map<string, Component[]>;
  nets: Map<string, Net[]>;
  diagnostics: Diagnostic[];
}

export interface DiscoveryOptions { maxFiles?: number; maxDepth?: number; sniffBytes?: number; maxTotalBytes?: number; signal?: AbortSignal }

function normalize(path: string): string { return path.replaceAll("\\", "/"); }
export function normalizeLookup(value: string): string { return value.trim().toUpperCase(); }
export function boundedLimit(limit?: number): number { return Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT)); }

export async function containedPath(cwd: string, input = ".", requireFile = false): Promise<string> {
  if (/\r|\n/.test(input)) throw new Error("Paths cannot contain line breaks");
  const root = await realpath(cwd);
  const candidate = resolve(cwd, input.replace(/^@/, ""));
  const canonical = await realpath(candidate);
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes working directory: ${input}`);
  const details = await stat(canonical);
  if (requireFile && !details.isFile()) throw new Error(`Expected a file: ${input}`);
  return canonical;
}

function hashBuffer(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
async function hashFile(path: string): Promise<string> { return hashBuffer(await readFile(path)); }

function globRegex(pattern: string): RegExp | undefined {
  let source = pattern.trim();
  if (!source || source.startsWith("#") || source.startsWith("!")) return undefined;
  source = source.replace(/^\//, "").replace(/\/$/, "/**");
  let output = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") { output += ".*"; index++; }
    else if (char === "*") output += "[^/]*";
    else if (char === "?") output += "[^/]";
    else output += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`(?:^|/)${output}(?:$|/)`);
}

async function ignoreRules(root: string): Promise<RegExp[]> {
  try {
    return (await readFile(join(root, ".gitignore"), "utf8")).split(/\r?\n/).map(globRegex).filter((item): item is RegExp => item !== undefined);
  } catch { return []; }
}

function looksText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let controls = 0;
  for (const byte of sample) if (byte === 0 || (byte < 9) || (byte > 13 && byte < 32)) controls++;
  return sample.length === 0 || controls / sample.length < 0.02;
}

export function classifyArtifact(name: string, buffer: Buffer): { kind: ArtifactKind; confidence: number; parser: string; evidence: string[] } {
  const lower = name.toLowerCase();
  const extension = extname(lower);
  const text = looksText(buffer) ? buffer.toString("utf8") : "";
  const head = text.slice(0, 100_000);
  if (buffer.subarray(0, 5).toString() === "%PDF-") return { kind: "pdf", confidence: 1, parser: "pdf", evidence: ["PDF magic"] };
  if (/IPC-2581|<IPC2581\b/i.test(head)) return { kind: "ipc-2581", confidence: 0.98, parser: "ipc-2581", evidence: ["IPC-2581 XML marker"] };
  if (/^P\s+JOB|^3(?:17|27)\b/m.test(head) || extension === ".356") return { kind: "ipc-d-356", confidence: 0.9, parser: "ipc-d-356", evidence: ["IPC-D-356 record marker"] };
  if (/^M48\s*$/m.test(head) && /^(?:INCH|METRIC)(?:,|$)/m.test(head)) return { kind: "drill", confidence: 0.96, parser: "excellon", evidence: ["Excellon M48 and unit markers"] };
  if (/%FS[LTD][AI]X\d+Y\d+\*%/i.test(head) || (/%MO(?:IN|MM)\*%/i.test(head) && /M0?2\*/.test(head))) return { kind: "gerber", confidence: 0.96, parser: "gerber", evidence: ["RS-274X format/unit markers"] };
  if (/\bMcu\.Name=|\bMxCube\.Version=/m.test(head) && extension === ".ioc") return { kind: "cubemx", confidence: 0.98, parser: "cubemx-ioc", evidence: ["CubeMX properties"] };
  if ((extension === ".tgz" || extension === ".zip" || extension === ".tar") && /odb/i.test(lower)) return { kind: "odb++", confidence: 0.55, parser: "odb-detect", evidence: ["ODB-like archive filename; contents not parsed"] };
  if (/^\s*\[\s*[^\]\r\n]+\s*\]\s*\r?\n[\s\S]*?^\s*\(\s*[^\)\r\n]+/m.test(head) || /\(\s*[^\r\n]+\r?\n\s*[A-Za-z]+\d+[-.]\w+/m.test(head)) return { kind: "schematic-netlist", confidence: 0.88, parser: "altium-protel-netlist", evidence: ["Protel component/net record structure"] };
  if ([".csv", ".tsv"].includes(extension) || /(?:^|[,;\t])\s*(?:designator|refdes|reference)\s*(?:[,;\t]|$)/i.test(head.split(/\r?\n/, 1)[0] ?? "")) {
    const header = (head.split(/\r?\n/, 1)[0] ?? "").toLowerCase();
    const placement = /(?:mid\s*x|center\s*x|pos\s*x|\bx\b)/i.test(header) && /(?:mid\s*y|center\s*y|pos\s*y|\by\b)/i.test(header);
    return { kind: placement ? "placement" : "bom", confidence: placement ? 0.86 : 0.72, parser: "delimited", evidence: [placement ? "designator and coordinate headers" : "delimited metadata headers"] };
  }
  if ([".json", ".yaml", ".yml"].includes(extension) && /(?:hardware|expectations|requiredConnections|pinMappings)/i.test(head)) return { kind: "manifest", confidence: 0.7, parser: "manifest", evidence: ["design-intent keys"] };
  return { kind: "unknown", confidence: 0, parser: "none", evidence: [] };
}

export async function discoverArtifacts(cwd: string, rootInput = ".", options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  if (options.signal?.aborted) throw new Error("Hardware discovery cancelled");
  const root = await containedPath(cwd, rootInput);
  const rootInfo = await stat(root);
  const base = rootInfo.isDirectory() ? root : dirname(root);
  const rules = await ignoreRules(base);
  const maxFiles = Math.min(50_000, Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxDepth = Math.min(50, Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const sniffBytes = Math.min(2 * 1024 * 1024, Math.max(1024, options.sniffBytes ?? DEFAULT_SNIFF_BYTES));
  const maxTotalBytes = Math.min(4 * 1024 * 1024 * 1024, Math.max(1024, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES));
  const artifacts: Artifact[] = [];
  const diagnostics: Diagnostic[] = [];
  let visited = 0;
  let inspectedBytes = 0;
  let truncated = false;

  async function inspect(path: string): Promise<void> {
    if (options.signal?.aborted) throw new Error("Hardware discovery cancelled");
    visited++;
    if (visited > maxFiles) { truncated = true; return; }
    const display = normalize(relative(cwd, path));
    try {
      const details = await stat(path);
      if (!details.isFile()) return;
      if (inspectedBytes + details.size > maxTotalBytes) {
        truncated = true;
        diagnostics.push({ severity: "warning", message: `Skipped artifact candidate because discovery byte limit (${maxTotalBytes}) would be exceeded`, path: display });
        return;
      }
      inspectedBytes += details.size;
      const full = await readFile(path);
      const classified = classifyArtifact(display, full.subarray(0, sniffBytes));
      if (classified.kind === "unknown") return;
      const artifactDiagnostics: Diagnostic[] = [];
      if (details.size === 0) artifactDiagnostics.push({ severity: "warning", message: "Artifact is empty", path: display });
      artifacts.push({ path: display, absolutePath: path, ...classified, size: details.size, mtimeMs: details.mtimeMs, hash: hashBuffer(full), diagnostics: artifactDiagnostics });
    } catch (error) {
      diagnostics.push({ severity: "warning", message: `Could not inspect: ${error instanceof Error ? error.message : String(error)}`, path: display });
    }
  }

  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated) return;
    if (depth > maxDepth) { truncated = true; return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { diagnostics.push({ severity: "warning", message: `Could not read directory: ${error instanceof Error ? error.message : String(error)}`, path: normalize(relative(cwd, directory)) }); return; }
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isSymbolicLink()) { diagnostics.push({ severity: "info", message: "Skipped symbolic link", path: normalize(relative(cwd, join(directory, entry.name))) }); continue; }
      const path = join(directory, entry.name);
      const rel = normalize(relative(base, path));
      if (rules.some((rule) => rule.test(rel))) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("bazel-")) await walk(path, depth + 1);
      } else if (entry.isFile()) await inspect(path);
    }
  }

  if (rootInfo.isFile()) await inspect(root); else await walk(root, 0);
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const duplicateHashes = new Map<string, Artifact[]>();
  for (const artifact of artifacts) duplicateHashes.set(artifact.hash, [...(duplicateHashes.get(artifact.hash) ?? []), artifact]);
  for (const duplicates of duplicateHashes.values()) if (duplicates.length > 1) for (const artifact of duplicates) artifact.diagnostics.push({ severity: "warning", message: `Duplicate content: ${duplicates.map((item) => item.path).join(", ")}`, path: artifact.path });
  const groups = new Map<string, Artifact[]>();
  for (const artifact of artifacts) groups.set(dirname(artifact.path), [...(groups.get(dirname(artifact.path)) ?? []), artifact]);
  const sets = [...groups.entries()].map(([directory, members]) => {
    const hashes = members.map((item) => item.hash).sort().join(":");
    return { id: `hw-${createHash("sha256").update(hashes).digest("hex").slice(0, 12)}`, paths: members.map((item) => item.path), reason: `same directory: ${directory}`, ambiguous: members.filter((item) => item.kind === "pdf").length > 1 || members.filter((item) => item.kind === "schematic-netlist").length > 1 };
  });
  return { root: normalize(relative(cwd, root)) || ".", artifacts, sets, diagnostics, truncated };
}

function parseDelimited(text: string): { headers: string[]; rows: Array<{ values: string[]; line: number }>; delimiter: string; diagnostics: Diagnostic[] } {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", "\t", ";", "|"];
  const delimiter = candidates.sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const records: Array<{ values: string[]; line: number }> = [];
  const diagnostics: Diagnostic[] = [];
  let row: string[] = [], field = "", quoted = false, line = 1, startLine = 1;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index] ?? "\n";
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else { field += char; if (char === "\n") line++; }
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); if (row.some((value) => value.trim())) records.push({ values: row, line: startLine }); row = []; field = ""; line++; startLine = line; }
    else field += char;
  }
  if (quoted) diagnostics.push({ severity: "warning", message: "Unterminated quoted field" });
  const headers = (records.shift()?.values ?? []).map((value) => value.trim());
  return { headers, rows: records, delimiter, diagnostics };
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header.trim())));
}
function splitDesignators(value: string): string[] { return value.split(/[,;\s]+/).map((item) => item.trim()).filter((item) => /^[A-Za-z]+\d+[A-Za-z0-9._-]*$/.test(item)); }
function numberValue(value?: string): number | undefined { const parsed = Number(value?.replace(/[^0-9+-.]/g, "")); return Number.isFinite(parsed) ? parsed : undefined; }

function parseBomOrPlacement(artifact: Artifact, text: string): ParsedArtifact {
  const table = parseDelimited(text);
  const refIndex = headerIndex(table.headers, [/designator/i, /refdes/i, /^reference$/i, /^ref$/i]);
  const valueIndex = headerIndex(table.headers, [/^value$/i, /comment/i, /description/i]);
  const footprintIndex = headerIndex(table.headers, [/footprint/i, /pattern/i]);
  const xIndex = headerIndex(table.headers, [/^(?:mid|center|pos(?:ition)?)?\s*x$/i]);
  const yIndex = headerIndex(table.headers, [/^(?:mid|center|pos(?:ition)?)?\s*y$/i]);
  const rotationIndex = headerIndex(table.headers, [/rotation/i, /^rot$/i]);
  const sideIndex = headerIndex(table.headers, [/^side$/i, /^layer$/i]);
  const dnpIndex = headerIndex(table.headers, [/dnp/i, /fitted/i, /populate/i]);
  const components: Component[] = [];
  const diagnostics = [...table.diagnostics];
  if (refIndex < 0) diagnostics.push({ severity: "error", message: "No designator/reference column", path: artifact.path });
  for (const row of table.rows) {
    if (refIndex < 0) break;
    const refs = splitDesignators(row.values[refIndex] ?? "");
    if (!refs.length) { diagnostics.push({ severity: "warning", message: "Skipped row without a usable designator", path: artifact.path, line: row.line }); continue; }
    for (const ref of refs) {
      const dnpRaw = dnpIndex >= 0 ? (row.values[dnpIndex] ?? "") : "";
      const provenance: Provenance = { path: artifact.path, parser: artifact.parser, line: row.line, evidence: "metadata" };
      components.push({ ref, value: valueIndex >= 0 ? row.values[valueIndex]?.trim() || undefined : undefined, footprint: footprintIndex >= 0 ? row.values[footprintIndex]?.trim() || undefined : undefined, x: xIndex >= 0 ? numberValue(row.values[xIndex]) : undefined, y: yIndex >= 0 ? numberValue(row.values[yIndex]) : undefined, rotation: rotationIndex >= 0 ? numberValue(row.values[rotationIndex]) : undefined, side: sideIndex >= 0 ? row.values[sideIndex]?.trim() || undefined : undefined, dnp: /^(?:1|yes|true|dnp|not fitted)$/i.test(dnpRaw) || (/fitted/i.test(table.headers[dnpIndex] ?? "") && /^(?:0|no|false)$/i.test(dnpRaw)), pins: [], provenance: [provenance] });
    }
  }
  return { artifact, components, nets: [], diagnostics, metadata: { delimiter: table.delimiter, rows: table.rows.length } };
}

function parseProtelNetlist(artifact: Artifact, text: string): ParsedArtifact {
  const components: Component[] = [];
  const nets: Net[] = [];
  const diagnostics: Diagnostic[] = [];
  const componentByRef = new Map<string, Component>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "[") continue;
    const body: Array<{ value: string; line: number }> = [];
    while (++index < lines.length && lines[index].trim() !== "]") if (lines[index].trim()) body.push({ value: lines[index].trim(), line: index + 1 });
    if (!body.length) continue;
    const ref = body[0].value;
    if (!/^[A-Za-z]+\d+/.test(ref)) continue;
    const provenance: Provenance = { path: artifact.path, parser: artifact.parser, line: body[0].line, evidence: "fact" };
    const component: Component = { ref, footprint: body[1]?.value || undefined, value: body[2]?.value || undefined, pins: [], provenance: [provenance] };
    components.push(component); componentByRef.set(normalizeLookup(ref), component);
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "(") continue;
    const start = index + 1;
    const name = lines[++index]?.trim();
    if (!name) continue;
    const pins: Pin[] = [];
    while (++index < lines.length && lines[index].trim() !== ")") {
      const value = lines[index].trim(); if (!value) continue;
      const match = value.match(/^(.+?)[-.]([^-.\s]+)$/);
      if (!match) { diagnostics.push({ severity: "warning", message: `Malformed net member: ${value}`, path: artifact.path, line: index + 1 }); continue; }
      const pin: Pin = { ref: match[1], pin: match[2], net: name, provenance: { path: artifact.path, parser: artifact.parser, line: index + 1, evidence: "fact" } };
      pins.push(pin); componentByRef.get(normalizeLookup(pin.ref))?.pins.push(pin);
    }
    nets.push({ name, pins, authority: "schematic", provenance: [{ path: artifact.path, parser: artifact.parser, line: start, evidence: "fact" }] });
  }
  if (!nets.length) diagnostics.push({ severity: "error", message: "No net records parsed", path: artifact.path });
  return { artifact, components, nets, diagnostics, metadata: { format: "Protel text netlist" } };
}

function attributes(fragment: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of fragment.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) result[match[1].toLowerCase()] = match[2];
  return result;
}
function parseIpc2581(artifact: Artifact, text: string): ParsedArtifact {
  const components: Component[] = [], nets: Net[] = [], diagnostics: Diagnostic[] = [];
  const byRef = new Map<string, Component>();
  for (const match of text.matchAll(/<(?:Component|Instance)\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]); const ref = attrs.refdes ?? attrs.ref ?? attrs.name;
    if (!ref) continue;
    const provenance: Provenance = { path: artifact.path, parser: artifact.parser, line: text.slice(0, match.index).split("\n").length, evidence: "fact" };
    const component: Component = { ref, footprint: attrs.packageref ?? attrs.package, x: numberValue(attrs.x), y: numberValue(attrs.y), rotation: numberValue(attrs.rotation), pins: [], provenance: [provenance] };
    components.push(component); byRef.set(normalizeLookup(ref), component);
  }
  for (const match of text.matchAll(/<LogicalNet\b([^>]*)>([\s\S]*?)<\/LogicalNet>/gi)) {
    const attrs = attributes(match[1]); const name = attrs.name ?? attrs.netname ?? ""; const pins: Pin[] = [];
    for (const pinMatch of match[2].matchAll(/<(?:PinRef|PinReference)\b([^>]*)\/?\s*>/gi)) {
      const pinAttrs = attributes(pinMatch[1]); const ref = pinAttrs.componentref ?? pinAttrs.refdes ?? pinAttrs.component; const pinName = pinAttrs.pin ?? pinAttrs.pinref ?? pinAttrs.name;
      if (!ref || !pinName) continue;
      const pin: Pin = { ref, pin: pinName, net: name, provenance: { path: artifact.path, parser: artifact.parser, evidence: "fact" } };
      pins.push(pin); byRef.get(normalizeLookup(ref))?.pins.push(pin);
    }
    nets.push({ name, pins, authority: "pcb", provenance: [{ path: artifact.path, parser: artifact.parser, line: text.slice(0, match.index).split("\n").length, evidence: "fact" }] });
  }
  if (!components.length && !nets.length) diagnostics.push({ severity: "error", message: "IPC-2581 marker found but supported component/net records were not parsed", path: artifact.path });
  return { artifact, components, nets, diagnostics, metadata: { format: "IPC-2581", experimental: true } };
}

function parseIpc356(artifact: Artifact, text: string): ParsedArtifact {
  const nets = new Map<string, Pin[]>(); const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]; if (!/^3(?:17|27)/.test(line)) continue;
    const tokens = line.trim().split(/\s+/); const net = tokens[1]?.replace(/^NNAME/, "");
    const refPin = tokens.find((token) => /^[A-Za-z]+\d+-[^\s]+$/.test(token));
    if (!net || !refPin) { diagnostics.push({ severity: "warning", message: "Unsupported IPC-D-356 access record", path: artifact.path, line: index + 1 }); continue; }
    const [ref, pinName] = refPin.split("-", 2);
    const pin: Pin = { ref, pin: pinName, net, provenance: { path: artifact.path, parser: artifact.parser, line: index + 1, evidence: "fact" } };
    nets.set(net, [...(nets.get(net) ?? []), pin]);
  }
  return { artifact, components: [], nets: [...nets].map(([name, pins]) => ({ name, pins, authority: "manufactured", provenance: [{ path: artifact.path, parser: artifact.parser, evidence: "fact" }] })), diagnostics, metadata: { format: "IPC-D-356", experimental: true } };
}

function parseGerber(artifact: Artifact, text: string): ParsedArtifact {
  const units = text.match(/%MO(IN|MM)\*%/i)?.[1]?.toUpperCase(); const format = text.match(/%FS[^X]*X(\d+)Y(\d+)\*%/i); const apertures = [...text.matchAll(/%ADD\d+/g)].length; const features = [...text.matchAll(/D0?[123]\*/g)].length;
  return { artifact, components: [], nets: [], diagnostics: [], geometry: { kind: "gerber", units, format: format ? `X${format[1]}Y${format[2]}` : undefined, features, tools: apertures, provenance: { path: artifact.path, parser: artifact.parser, evidence: "fact" } }, metadata: { units: units ?? "unknown", apertures, features } };
}
function parseDrill(artifact: Artifact, text: string): ParsedArtifact {
  const unitMatch = text.match(/^(INCH|METRIC)(?:,([^\r\n]+))?/mi); const tools = [...text.matchAll(/^T\d+C/igm)].length; const features = [...text.matchAll(/^X[-+]?\d+Y[-+]?\d+/igm)].length;
  return { artifact, components: [], nets: [], diagnostics: [], geometry: { kind: "drill", units: unitMatch?.[1]?.toUpperCase(), format: unitMatch?.[2], features, tools, provenance: { path: artifact.path, parser: artifact.parser, evidence: "fact" } }, metadata: { units: unitMatch?.[1] ?? "unknown", tools, holes: features } };
}
function parseCubeMx(artifact: Artifact, text: string): ParsedArtifact {
  const metadata: Record<string, string> = {}; for (const line of text.split(/\r?\n/)) { const match = line.match(/^([^#=]+)=(.*)$/); if (match && (/GPIO_Label$/.test(match[1]) || /^Mcu\.(?:Name|CPN)/.test(match[1]))) metadata[match[1]] = match[2]; }
  return { artifact, components: [], nets: [], diagnostics: [], metadata };
}

function parseManifest(artifact: Artifact, text: string): ParsedArtifact {
  const diagnostics: Diagnostic[] = [];
  if (!artifact.path.toLowerCase().endsWith(".json")) return { artifact, components: [], nets: [], diagnostics: [{ severity: "warning", message: "YAML design-intent manifests are detected but not parsed; use JSON", path: artifact.path }], metadata: {} };
  const source = JSON.parse(text) as { hardware?: { requiredConnections?: unknown; forbiddenConnections?: unknown }; requiredConnections?: unknown; forbiddenConnections?: unknown };
  const body = source.hardware ?? source;
  const readConnections = (value: unknown, name: string): ConnectionExpectation[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { diagnostics.push({ severity: "error", message: `${name} must be an array`, path: artifact.path }); return []; }
    const result: ConnectionExpectation[] = [];
    for (const [index, item] of value.entries()) {
      if (!item || typeof item !== "object") { diagnostics.push({ severity: "warning", message: `${name}[${index}] is not an object`, path: artifact.path }); continue; }
      const entry = item as Record<string, unknown>;
      if (typeof entry.ref !== "string" || typeof entry.pin !== "string" || typeof entry.net !== "string") { diagnostics.push({ severity: "warning", message: `${name}[${index}] requires string ref, pin, and net`, path: artifact.path }); continue; }
      result.push({ ref: entry.ref, pin: entry.pin, net: entry.net, note: typeof entry.note === "string" ? entry.note : undefined });
    }
    return result;
  };
  const intent = { requiredConnections: readConnections(body.requiredConnections, "requiredConnections"), forbiddenConnections: readConnections(body.forbiddenConnections, "forbiddenConnections") };
  return { artifact, components: [], nets: [], intent, diagnostics, metadata: { requiredConnections: intent.requiredConnections.length, forbiddenConnections: intent.forbiddenConnections.length } };
}

export async function parseArtifact(artifact: Artifact, textOverride?: string): Promise<ParsedArtifact> {
  try {
    if (artifact.kind === "pdf") return { artifact, components: [], nets: [], diagnostics: [], metadata: {} };
    const text = textOverride ?? await readFile(artifact.absolutePath, "utf8");
    if (artifact.kind === "schematic-netlist") return parseProtelNetlist(artifact, text);
    if (artifact.kind === "bom" || artifact.kind === "placement") return parseBomOrPlacement(artifact, text);
    if (artifact.kind === "ipc-2581") return parseIpc2581(artifact, text);
    if (artifact.kind === "ipc-d-356") return parseIpc356(artifact, text);
    if (artifact.kind === "gerber") return parseGerber(artifact, text);
    if (artifact.kind === "drill") return parseDrill(artifact, text);
    if (artifact.kind === "cubemx") return parseCubeMx(artifact, text);
    if (artifact.kind === "manifest") return parseManifest(artifact, text);
    return { artifact, components: [], nets: [], diagnostics: [{ severity: "warning", message: `No semantic parser for ${artifact.kind}`, path: artifact.path }], metadata: {} };
  } catch (error) {
    return { artifact, components: [], nets: [], diagnostics: [{ severity: "error", message: `Parse failed: ${error instanceof Error ? error.message : String(error)}`, path: artifact.path }], metadata: {} };
  }
}

export async function buildIndex(artifacts: Artifact[]): Promise<HardwareIndex> {
  const parsed = await Promise.all(artifacts.map((artifact) => parseArtifact(artifact)));
  const components = new Map<string, Component[]>(), nets = new Map<string, Net[]>();
  for (const item of parsed) {
    for (const component of item.components) components.set(normalizeLookup(component.ref), [...(components.get(normalizeLookup(component.ref)) ?? []), component]);
    for (const net of item.nets) nets.set(normalizeLookup(net.name), [...(nets.get(normalizeLookup(net.name)) ?? []), net]);
  }
  return { parsed, components, nets, diagnostics: parsed.flatMap((item) => item.diagnostics) };
}

export function capabilityMatrix(parsed: ParsedArtifact[]): Record<Capability, CapabilityState> {
  const kinds = new Set(parsed.map((item) => item.artifact.kind));
  const failed = (kind: ArtifactKind) => parsed.some((item) => item.artifact.kind === kind && item.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  return {
    visualSchematic: kinds.has("pdf") ? "available" : "absent",
    logicalConnectivity: failed("schematic-netlist") ? "parse-failed" : kinds.has("schematic-netlist") ? "available" : "absent",
    partMetadata: failed("bom") ? "parse-failed" : kinds.has("bom") ? "available" : "absent",
    assemblyPlacement: failed("placement") ? "parse-failed" : kinds.has("placement") ? "available" : "absent",
    fabricationGeometry: kinds.has("gerber") || kinds.has("drill") ? "available" : "absent",
    manufacturedConnectivity: failed("ipc-d-356") ? "parse-failed" : kinds.has("ipc-d-356") ? "experimental" : "absent",
    semanticLayout: failed("ipc-2581") ? "parse-failed" : kinds.has("ipc-2581") ? "experimental" : kinds.has("odb++") ? "unsupported" : "absent",
    designIntent: failed("manifest") ? "parse-failed" : parsed.some((item) => item.intent !== undefined) ? "available" : kinds.has("manifest") ? "unsupported" : "absent",
  };
}

export function selectPage(text: string, page: number): string {
  return text.split("\f")[Math.max(0, page - 1)] ?? "";
}

export async function cachePathFor(artifact: Artifact, suffix: string): Promise<string> {
  const directory = join(tmpdir(), "pi-hardware-cache", `${PARSER_VERSION}-${artifact.hash}`);
  await mkdir(directory, { recursive: true });
  return join(directory, suffix);
}

export async function cachedText(artifact: Artifact): Promise<string | undefined> {
  const path = await cachePathFor(artifact, "text.txt");
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}
export async function storeCachedText(artifact: Artifact, text: string): Promise<void> { await writeFile(await cachePathFor(artifact, "text.txt"), text, "utf8"); }

export async function temporaryRenderDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), "pi-hardware-render-")); }
export async function fileExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
export { basename, dirname, hashFile };
