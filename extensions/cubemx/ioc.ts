import { readFile, writeFile } from "node:fs/promises";

export interface IocLine {
  raw: string;
  eol: string;
  key?: string;
  value?: string;
}

export interface IocDocument {
  lines: IocLine[];
  properties: Map<string, IocLine[]>;
  defaultEol: string;
}

function separatorIndex(line: string): number {
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "=") {
      return i;
    }
  }
  return -1;
}

export function parseIoc(text: string): IocDocument {
  const lines: IocLine[] = [];
  const properties = new Map<string, IocLine[]>();
  const pattern = /(.*?)(\r\n|\n|\r|$)/gs;
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "") break;
    const raw = match[1];
    const eol = match[2];
    const line: IocLine = { raw, eol };
    if (raw.length > 0 && !raw.startsWith("#") && !raw.startsWith("!")) {
      const separator = separatorIndex(raw);
      if (separator >= 0) {
        line.key = raw.slice(0, separator);
        line.value = raw.slice(separator + 1);
        const matches = properties.get(line.key) ?? [];
        matches.push(line);
        properties.set(line.key, matches);
      }
    }
    lines.push(line);
  }
  return {
    lines,
    properties,
    defaultEol: lines.find((line) => line.eol)?.eol ?? "\n",
  };
}

export function serializeIoc(document: IocDocument): string {
  return document.lines.map((line) => `${line.raw}${line.eol}`).join("");
}

export async function readIoc(path: string): Promise<IocDocument> {
  return parseIoc(await readFile(path, "utf8"));
}

export function exactProperty(document: IocDocument, key: string): string | undefined {
  const matches = document.properties.get(key) ?? [];
  if (matches.length > 1) throw new Error(`Ambiguous duplicate property: ${key}`);
  return matches[0]?.value;
}

export interface PatchOperation {
  key: string;
  value?: string;
  remove?: boolean;
}

export interface PatchChange {
  key: string;
  before?: string;
  after?: string;
}

export function patchIoc(document: IocDocument, operations: PatchOperation[]): PatchChange[] {
  const operationKeys = new Set<string>();
  const changes: PatchChange[] = [];
  for (const operation of operations) {
    if (!operation.key || operation.key.includes("\n") || operation.key.includes("\r") || separatorIndex(operation.key) >= 0) {
      throw new Error(`Invalid exact property key: ${JSON.stringify(operation.key)}`);
    }
    if (operationKeys.has(operation.key)) throw new Error(`Property appears in multiple operations: ${operation.key}`);
    operationKeys.add(operation.key);
    if (operation.remove && operation.value !== undefined) throw new Error(`Set either value or remove for ${operation.key}, not both`);
    if (!operation.remove && operation.value === undefined) throw new Error(`Missing value for ${operation.key}`);
    if (operation.value?.includes("\n") || operation.value?.includes("\r")) throw new Error(`Property values must be single-line: ${operation.key}`);

    const matches = document.properties.get(operation.key) ?? [];
    if (matches.length > 1) throw new Error(`Ambiguous duplicate property: ${operation.key}`);
    const existing = matches[0];
    const before = existing?.value;
    if (operation.remove) {
      if (!existing) continue;
      const index = document.lines.indexOf(existing);
      if (index === document.lines.length - 1 && existing.eol === "" && index > 0) document.lines[index - 1].eol = "";
      document.lines.splice(index, 1);
      document.properties.delete(operation.key);
      changes.push({ key: operation.key, before });
      continue;
    }
    if (existing) {
      if (before === operation.value) continue;
      existing.value = operation.value;
      existing.raw = `${operation.key}=${operation.value}`;
    } else {
      const last = document.lines.at(-1);
      const hadFinalEol = last !== undefined && last.eol !== "";
      if (last && !hadFinalEol) last.eol = document.defaultEol;
      const added = { raw: `${operation.key}=${operation.value}`, eol: hadFinalEol ? document.defaultEol : "", key: operation.key, value: operation.value };
      document.lines.push(added);
      document.properties.set(operation.key, [added]);
    }
    changes.push({ key: operation.key, before, after: operation.value });
  }
  return changes;
}

export async function writeIoc(path: string, document: IocDocument): Promise<void> {
  await writeFile(path, serializeIoc(document), "utf8");
}
