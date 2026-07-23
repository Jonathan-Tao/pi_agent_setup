import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedLimit, buildIndex, cachePathFor, capabilityMatrix, classifyArtifact, containedPath, discoverArtifacts, parseArtifact, type Artifact } from "./core.ts";

async function temporary(): Promise<string> { return mkdtemp(join(tmpdir(), "hardware-test-")); }
function artifact(path: string, kind: Artifact["kind"], parser: string): Artifact {
  return { path, absolutePath: path, kind, parser, confidence: 1, size: 1, mtimeMs: 1, hash: "hash", evidence: ["fixture"], diagnostics: [] };
}

test("content classification does not require conventional filenames", () => {
  assert.equal(classifyArtifact("anything.bin", Buffer.from("%PDF-1.4\n")).kind, "pdf");
  assert.equal(classifyArtifact("random.data", Buffer.from("%FSLAX24Y24*%\n%MOMM*%\nX1Y1D01*\nM02*\n")).kind, "gerber");
  assert.equal(classifyArtifact("holes.weird", Buffer.from("M48\nMETRIC,TZ\nT01C0.3\n%\nX10Y10\n")).kind, "drill");
  assert.equal(classifyArtifact("board.xml", Buffer.from("<?xml version=\"1.0\"?><IPC-2581></IPC-2581>\n")).kind, "ipc-2581");
  assert.equal(classifyArtifact("metadata-without-extension", Buffer.from("Designator,Comment,Footprint\nR1,10k,0402\n")).kind, "bom");
});

test("discovery supports arbitrary nesting, honors ignore rules, and skips symlinks", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "odd", "nest"), { recursive: true });
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "odd", "nest", "not-a-schematic-name"), "%PDF-1.4\n");
    await writeFile(join(root, "ignored", "hidden.pdf"), "%PDF-1.4\n");
    await symlink(join(root, "odd", "nest", "not-a-schematic-name"), join(root, "alias.pdf"));
    const result = await discoverArtifacts(root);
    assert.deepEqual(result.artifacts.map((item) => item.path), ["odd/nest/not-a-schematic-name"]);
    assert.ok(result.diagnostics.some((item) => item.message.includes("symbolic link")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery is bounded and path containment rejects escapes", async () => {
  const root = await temporary();
  try {
    await writeFile(join(root, "a.pdf"), `%PDF-1.4\n${"a".repeat(700)}`);
    await writeFile(join(root, "b.pdf"), `%PDF-1.4\n${"b".repeat(700)}`);
    const result = await discoverArtifacts(root, ".", { maxFiles: 1 });
    assert.equal(result.truncated, true);
    const byteLimited = await discoverArtifacts(root, ".", { maxTotalBytes: 1024 });
    assert.equal(byteLimited.truncated, true);
    assert.ok(byteLimited.diagnostics.some((item) => item.message.includes("byte limit")));
    await assert.rejects(() => containedPath(root, "../outside"), /escapes|ENOENT/);
    await assert.rejects(() => containedPath(root, "bad\npath"), /line breaks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Protel netlist parsing preserves explicit connectivity and malformed diagnostics", async () => {
  const source = "[\nU1\nQFN\nMCU\n]\n[\nR1\n0402\n10k\n]\n(\nSPI_CLK\nU1-5\nR1-1\nbad member\n)\n";
  const parsed = await parseArtifact(artifact("fixture.net", "schematic-netlist", "altium-protel-netlist"), source);
  assert.equal(parsed.components.length, 2);
  assert.deepEqual(parsed.nets[0].pins.map((pin) => `${pin.ref}.${pin.pin}`), ["U1.5", "R1.1"]);
  assert.ok(parsed.diagnostics.some((item) => item.message.includes("Malformed")));
  assert.equal(capabilityMatrix([parsed]).logicalConnectivity, "available");
});

test("BOM parser handles grouped designators, quoted fields, DNP, and malformed rows", async () => {
  const source = "Designator,Comment,Footprint,DNP\n\"R1, R2\",\"10k, 1%\",0402,false\nC1,100n,0402,true\nnot-a-ref,x,y,false\n";
  const parsed = await parseArtifact(artifact("fixture.csv", "bom", "delimited"), source);
  assert.deepEqual(parsed.components.map((item) => item.ref), ["R1", "R2", "C1"]);
  assert.equal(parsed.components[2].dnp, true);
  assert.ok(parsed.diagnostics.some((item) => item.message.includes("Skipped row")));
});

test("placement and BOM metadata never create connectivity", async () => {
  const parsed = await parseArtifact(artifact("place.csv", "placement", "delimited"), "Designator,Mid X,Mid Y,Layer\nU1,1.2mm,3.4mm,Top\n");
  assert.equal(parsed.nets.length, 0);
  assert.equal(parsed.components[0].x, 1.2);
  const index = await buildIndex([]);
  assert.equal(index.nets.size, 0);
});

test("IPC-2581, IPC-D-356, Gerber, and Excellon fixtures expose only represented facts", async () => {
  const ipc = await parseArtifact(artifact("board.xml", "ipc-2581", "ipc-2581"), "<IPC-2581><Component refDes=\"U1\" packageRef=\"QFN\" x=\"1\" y=\"2\"/><LogicalNet name=\"CAN_TX\"><PinRef componentRef=\"U1\" pin=\"4\"/></LogicalNet></IPC-2581>");
  assert.equal(ipc.components[0].ref, "U1"); assert.equal(ipc.nets[0].authority, "pcb");
  const d356 = await parseArtifact(artifact("board.356", "ipc-d-356", "ipc-d-356"), "P JOB demo\n317 CAN_TX U1-4\n");
  assert.equal(d356.nets[0].authority, "manufactured");
  const gerber = await parseArtifact(artifact("copper.gbr", "gerber", "gerber"), "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.2*%\nX1Y1D01*\nM02*\n");
  assert.equal(gerber.geometry?.units, "MM");
  const drill = await parseArtifact(artifact("holes.drl", "drill", "excellon"), "M48\nMETRIC,TZ\nT01C0.3\n%\nX10Y20\n");
  assert.equal(drill.geometry?.features, 1);
});

test("parse failures remain isolated and capability reports them", async () => {
  const broken = await parseArtifact(artifact("broken.net", "schematic-netlist", "altium-protel-netlist"), "not a netlist");
  const good = await parseArtifact(artifact("bom.csv", "bom", "delimited"), "Designator,Value\nR1,1k\n");
  const capabilities = capabilityMatrix([broken, good]);
  assert.equal(capabilities.logicalConnectivity, "parse-failed");
  assert.equal(capabilities.partMetadata, "available");
});

test("JSON design intent is validated but does not create connectivity", async () => {
  const parsed = await parseArtifact(artifact("expectations.json", "manifest", "manifest"), JSON.stringify({ hardware: { requiredConnections: [{ ref: "U1", pin: "4", net: "CAN_TX" }], forbiddenConnections: [{ ref: "J1", pin: "8", net: "HV+" }] } }));
  assert.equal(parsed.intent?.requiredConnections.length, 1);
  assert.equal(parsed.nets.length, 0);
  assert.equal(capabilityMatrix([parsed]).designIntent, "available");
});

test("cache keys and bounded result limits are stable", async () => {
  const first = artifact("a.pdf", "pdf", "pdf"); const second = { ...first, hash: "other" };
  assert.notEqual(await cachePathFor(first, "text.txt"), await cachePathFor(second, "text.txt"));
  assert.equal(boundedLimit(0), 1);
  assert.equal(boundedLimit(9999), 500);
});

test("aborted discovery is cancelled", async () => {
  const root = await temporary(); const controller = new AbortController(); controller.abort();
  try { await assert.rejects(() => discoverArtifacts(root, ".", { signal: controller.signal }), /cancelled/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
