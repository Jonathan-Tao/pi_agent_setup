import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { IocDocument } from "./ioc.ts";
import { exactProperty, readIoc } from "./ioc.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

export interface Exec {
  (command: string, args: string[], options: { signal?: AbortSignal; timeout?: number }): Promise<CommandResult>;
}

export interface FileChange {
  path: string;
  status: "created" | "changed" | "deleted";
}

const SKIP_DIRECTORIES = new Set([".git", ".cache", "node_modules", "bazel-bin", "bazel-out", "bazel-testlogs"]);
const PRESERVE_NAMES = new Set(["BUILD", "BUILD.bazel", ".gitignore", ".bazelrc", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"]);

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableFromCandidate(candidate: string, names: string[]): Promise<string | undefined> {
  try {
    const info = await stat(candidate);
    if (info.isFile() && await executable(candidate)) return candidate;
    if (info.isDirectory()) {
      for (const name of names) {
        const nested = join(candidate, name);
        if (await executable(nested)) return nested;
      }
    }
  } catch {}
  return undefined;
}

async function versionedInstallCandidates(root: string, names: string[]): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /(?:stm32)?cubemx/i.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .flatMap((entry) => names.map((name) => join(root, entry.name, name)));
  } catch {
    return [];
  }
}

export async function discoverExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | undefined> {
  const names = platform === "win32" ? ["STM32CubeMX.exe", "STM32CubeMX"] : ["stm32cubemx", "STM32CubeMX"];
  const configured = env.STM32CUBEMX_PATH?.replace(/^@/, "");
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(configured);
    const found = await executableFromCandidate(candidate, names);
    if (!found) throw new Error(`STM32CUBEMX_PATH is not an executable or CubeMX installation directory: ${candidate}`);
    return found;
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await executable(candidate)) return candidate;
    }
  }
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const common = platform === "darwin"
    ? ["/Applications/STMicroelectronics/STM32CubeMX.app/Contents/MacOS/STM32CubeMX", "/Applications/STM32CubeMX.app/Contents/MacOS/STM32CubeMX"]
    : platform === "win32"
      ? [join(env.ProgramFiles ?? "C:\\Program Files", "STMicroelectronics", "STM32Cube", "STM32CubeMX", "STM32CubeMX.exe"), join(home, "STMicroelectronics", "STM32CubeMX", "STM32CubeMX.exe")]
      : ["/usr/local/bin/stm32cubemx", "/opt/stm32cubemx/STM32CubeMX", "/opt/STMicroelectronics/STM32Cube/STM32CubeMX/STM32CubeMX", join(home, "STMicroelectronics", "STM32CubeMX", "STM32CubeMX")];
  const versionedRoots = platform === "win32" ? [join(env.ProgramFiles ?? "C:\\Program Files", "STMicroelectronics")] : platform === "darwin" ? ["/Applications/STMicroelectronics"] : ["/opt", join(home, "STMicroelectronics")];
  const candidates = [...common];
  for (const root of versionedRoots) candidates.push(...await versionedInstallCandidates(root, names));
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  return undefined;
}

export async function containedPath(cwd: string, input: string, extension?: string): Promise<string> {
  if (/[\r\n]/.test(input)) throw new Error("Paths cannot contain line breaks");
  const root = await realpath(cwd);
  const candidate = resolve(cwd, input.replace(/^@/, ""));
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    canonical = candidate;
  }
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes working directory: ${input}`);
  if (extension && !canonical.toLowerCase().endsWith(extension)) throw new Error(`Expected a ${extension} file: ${input}`);
  return canonical;
}

export async function discoverIocFiles(cwd: string): Promise<string[]> {
  const root = await realpath(cwd);
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("bazel-")) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ioc")) found.push(relative(root, path));
    }
  }
  await walk(root);
  return found.sort();
}

function values(document: IocDocument, predicate: (key: string, value: string) => boolean): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [key, matches] of document.properties) {
    if (matches.length === 1 && matches[0].value !== undefined && predicate(key, matches[0].value)) result.push([key, matches[0].value]);
  }
  return result;
}

function compactPairs(pairs: Array<[string, string]>, limit = 30): string[] {
  const lines = pairs.slice(0, limit).map(([key, value]) => `  ${key}=${value}`);
  if (pairs.length > limit) lines.push(`  … ${pairs.length - limit} more (use query with an exact key or prefix)`);
  return lines;
}

function compactPins(pairs: Array<[string, string]>): string[] {
  const items = pairs.map(([pin, detail]) => `${pin}:${detail}`);
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += 6) lines.push(`  ${items.slice(index, index + 6).join(" | ")}`);
  return lines;
}

export function inspectIoc(document: IocDocument): string {
  const get = (key: string) => exactProperty(document, key) ?? "(not set)";
  const ips = values(document, (key) => /^Mcu\.IP\d+$/.test(key)).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const pins = values(document, (key) => /^Mcu\.Pin\d+$/.test(key)).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const pinDetails: Array<[string, string]> = [];
  for (const [, pin] of pins) {
    const signal = exactProperty(document, `${pin}.Signal`);
    const label = exactProperty(document, `${pin}.GPIO_Label`);
    pinDetails.push([pin, [signal, label && `label:${label}`].filter(Boolean).join("; ") || "assigned"]);
  }
  const ipNames = new Set(ips.map(([, value]) => value));
  const sections: Array<[string, Array<[string, string]>]> = [
    ["Peripheral configuration", values(document, (key) => ipNames.has(key.split(".")[0]) && !key.startsWith("NVIC.") && !key.startsWith("RCC."))],
    ["Clocks", values(document, (key) => key.startsWith("RCC.") || key.startsWith("PWR.") || /Clock|Freq/.test(key))],
    ["DMA", values(document, (key) => /(^|\.)DMA/.test(key) || key.startsWith("Dma."))],
    ["NVIC", values(document, (key, value) => key.startsWith("NVIC.") && value !== "false")],
    ["Memory", values(document, (key) => /MPU|Memory|Region|Linker/i.test(key))],
    ["Project", values(document, (key) => key.startsWith("ProjectManager."))],
  ];
  const output = [
    `MCU: ${get("Mcu.Name")} (${get("Mcu.CPN")}), family ${get("Mcu.Family")}, package ${get("Mcu.Package")}`,
    `CubeMX: ${get("MxCube.Version")} / ${get("MxDb.Version")}`,
    `Firmware: ${get("ProjectManager.FirmwarePackage")}`,
    `Peripherals (${ips.length}): ${ips.map(([, value]) => value).join(", ")}`,
    `Pins (${pinDetails.length}):`,
    ...compactPins(pinDetails),
  ];
  for (const [name, pairs] of sections) {
    output.push(`${name} (${pairs.length}):`, ...compactPairs(pairs));
  }
  return output.join("\n");
}

export function queryIoc(document: IocDocument, keys: string[] = [], prefix?: string): Array<[string, string]> {
  const selected = new Set(keys);
  const matches = values(document, (key) => selected.has(key) || (prefix !== undefined && key.startsWith(prefix)));
  for (const key of keys) {
    const count = document.properties.get(key)?.length ?? 0;
    if (count > 1) throw new Error(`Ambiguous duplicate property: ${key}`);
  }
  return matches;
}

function cubeArgument(path: string): string {
  return `"${path.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

export function cubeScript(iocPath: string, generate = false): string {
  const lines = [`config load ${cubeArgument(iocPath)}`];
  if (generate) lines.push(`project generate ${cubeArgument(dirname(iocPath))}`);
  lines.push("exit");
  return `${lines.join("\n")}\n`;
}

function commandOkay(result: CommandResult, expectedOk: number): boolean {
  const statuses = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim());
  const oks = statuses.filter((line) => line === "OK").length;
  return result.code === 0 && !result.killed && oks >= expectedOk && !statuses.includes("KO");
}

export async function runCubeMx(executablePath: string, script: string, exec: Exec, signal?: AbortSignal, timeout = 120_000): Promise<CommandResult & { ok: boolean; script: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cubemx-script-"));
  const scriptPath = join(directory, "commands.script");
  await writeFile(scriptPath, script, "utf8");
  try {
    const result = await exec(executablePath, ["-q", scriptPath], { signal, timeout });
    return { ...result, ok: commandOkay(result, script.includes("project generate") ? 2 : 1), script };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function installedDatabaseVersion(executablePath: string): Promise<string | undefined> {
  let installation = dirname(executablePath);
  if (installation === "/usr/bin" || installation === "/usr/local/bin") {
    try {
      const wrapper = await readFile(executablePath, "utf8");
      const match = wrapper.match(/(?:-jar\s+)?(\/[^\s"']*STM32CubeMX)/);
      if (match) installation = dirname(match[1]);
    } catch {}
  }
  try {
    const xml = await readFile(join(installation, "db", "package.xml"), "utf8");
    return xml.match(/Release="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

export function cubeVersionFromDatabase(database?: string): string | undefined {
  const digits = database?.match(/DB\.6\.0\.(\d{3})/)?.[1];
  return digits ? `6.${Number(digits.slice(0, 2))}.${Number(digits.slice(2))}` : undefined;
}

export async function versionWarnings(document: IocDocument, executablePath: string): Promise<string[]> {
  const warnings: string[] = [];
  const projectDb = exactProperty(document, "MxDb.Version");
  const projectCube = exactProperty(document, "MxCube.Version");
  const installedDb = await installedDatabaseVersion(executablePath);
  const installedCube = cubeVersionFromDatabase(installedDb);
  if (installedDb && projectDb && installedDb !== projectDb) warnings.push(`Database mismatch: project ${projectDb}, installed ${installedDb}`);
  if (installedCube && projectCube && installedCube !== projectCube) warnings.push(`CubeMX mismatch: project ${projectCube}, installed ${installedCube}`);
  const firmware = exactProperty(document, "ProjectManager.FirmwarePackage");
  if (firmware) {
    const folder = firmware.replace("STM32Cube FW_", "STM32Cube_FW_").replace(/ V(?=\d)/, "_V");
    const repository = process.env.STM32CUBE_REPOSITORY ?? join(process.env.HOME ?? "", "STM32Cube", "Repository");
    try { await access(join(repository, folder)); } catch { warnings.push(`Firmware package not found: ${join(repository, folder)}`); }
  }
  return warnings;
}

async function fileMap(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.set(relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  }
  await walk(root);
  return result;
}

export async function compareTrees(beforeRoot: string, afterRoot: string): Promise<FileChange[]> {
  const [before, after] = await Promise.all([fileMap(beforeRoot), fileMap(afterRoot)]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((path) => {
    if (!before.has(path)) return [{ path, status: "created" as const }];
    if (!after.has(path)) return [{ path, status: "deleted" as const }];
    if (before.get(path) !== after.get(path)) return [{ path, status: "changed" as const }];
    return [];
  });
}

function preservePath(path: string): boolean {
  const name = path.split(sep).at(-1) ?? path;
  return PRESERVE_NAMES.has(name) || name.endsWith(".lock");
}

async function userRegions(root: string): Promise<Map<string, Set<string>>> {
  const regions = new Map<string, Set<string>>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(c|h|cc|cpp|hpp)$/i.test(entry.name)) {
        const text = await readFile(path, "utf8");
        const begins = [...text.matchAll(/USER CODE BEGIN\s+([^\r\n*]+)/g)].map((match) => match[1].trim());
        const ends = [...text.matchAll(/USER CODE END\s+([^\r\n*]+)/g)].map((match) => match[1].trim());
        if (begins.length !== ends.length || begins.some((id, index) => id !== ends[index])) throw new Error(`Unbalanced USER CODE regions: ${relative(root, path)}`);
        if (begins.length) regions.set(relative(root, path), new Set(begins));
      }
    }
  }
  await walk(root);
  return regions;
}

async function ensureUserRegions(beforeRoot: string, afterRoot: string): Promise<void> {
  const [before, after] = await Promise.all([userRegions(beforeRoot), userRegions(afterRoot)]);
  for (const [path, ids] of before) {
    const next = after.get(path);
    for (const id of ids) if (!next?.has(id)) throw new Error(`CubeMX removed USER CODE region ${id} from ${path}`);
  }
}

async function ensureNoSymlinks(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Generation refuses projects containing symbolic links: ${relative(root, path)}`);
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
}

async function restoreSnapshot(snapshot: string, target: string): Promise<void> {
  const staging = await mkdtemp(join(dirname(target), ".pi-cubemx-restore-"));
  const restored = join(staging, basename(target));
  let targetRemoved = false;
  try {
    await cp(snapshot, restored, { recursive: true, preserveTimestamps: true });
    await rm(target, { recursive: true, force: true });
    targetRemoved = true;
    await rename(restored, target);
    targetRemoved = false;
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    if (!targetRemoved) await rm(staging, { recursive: true, force: true });
    if (targetRemoved) throw new Error(`Project restoration failed; recovery copy retained at ${restored}`, { cause: error });
    throw error;
  }
}

export async function generateIsolated(iocPath: string, executablePath: string, exec: Exec, options: { preview: boolean; signal?: AbortSignal; timeout?: number }): Promise<{ result: CommandResult & { ok: boolean; script: string }; changes: FileChange[] }> {
  const projectRoot = dirname(iocPath);
  await ensureNoSymlinks(projectRoot);
  const temp = await mkdtemp(join(tmpdir(), "pi-cubemx-project-"));
  const snapshot = join(temp, "snapshot");
  await cp(projectRoot, snapshot, { recursive: true, preserveTimestamps: true });
  if (options.preview) {
    const previewRoot = join(temp, "preview", projectRoot.split(sep).at(-1) ?? "project");
    await cp(projectRoot, previewRoot, { recursive: true, preserveTimestamps: true });
    const previewIoc = join(previewRoot, relative(projectRoot, iocPath));
    try {
      const result = await runCubeMx(executablePath, cubeScript(previewIoc, true), exec, options.signal, options.timeout ?? 300_000);
      if (!result.ok) throw Object.assign(new Error("CubeMX generation failed"), { cubeResult: result });
      await ensureUserRegions(snapshot, previewRoot);
      return { result, changes: await compareTrees(snapshot, previewRoot) };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  try {
    const result = await runCubeMx(executablePath, cubeScript(iocPath, true), exec, options.signal, options.timeout ?? 300_000);
    if (!result.ok) throw Object.assign(new Error("CubeMX generation failed; project restored"), { cubeResult: result });
    const changes = await compareTrees(snapshot, projectRoot);
    for (const change of changes.filter((item) => item.status !== "created" && preservePath(item.path))) {
      const destination = join(projectRoot, change.path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(snapshot, change.path), destination, { preserveTimestamps: true });
    }
    await ensureUserRegions(snapshot, projectRoot);
    return { result, changes: await compareTrees(snapshot, projectRoot) };
  } catch (error) {
    await restoreSnapshot(snapshot, projectRoot);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function followUpCommands(cwd: string, iocPath: string): string[] {
  const rel = relative(cwd, iocPath).split(sep);
  if (rel[0] !== "ecu") return [];
  if (rel[1] === "test" && rel[2]) {
    const board = rel[2];
    const commands = [`bazel build --config=${board} //ecu/test/${board}`];
    if (["fk723m1", "nucleo_h723", "stm32h723zg", "stm32h733vg"].includes(board)) commands.push(`bazel run //ecu/test/${board}:refresh_cdb`);
    return commands;
  }
  const ecu = rel[1];
  if (["bms", "dash", "pdb", "safety", "sensor"].includes(ecu)) return [`bazel build --config=${ecu} //ecu/${ecu}`, `bazel run //ecu/${ecu}:refresh_cdb`];
  return [];
}
