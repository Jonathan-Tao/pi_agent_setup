import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseIoc, patchIoc, serializeIoc } from "./ioc.ts";
import { containedPath, cubeScript, discoverExecutable, discoverIocFiles, generateIsolated, queryIoc, runCubeMx } from "./core.ts";

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cubemx-test-"));
}

test("IOC parsing and patching is lossless outside changed lines", () => {
  const source = "# header\r\nA=1\r\nEscaped\\:Key=x\\#y\r\nUnknown=a=b\r\n";
  const document = parseIoc(source);
  assert.equal(serializeIoc(document), source);
  assert.deepEqual(queryIoc(document, ["Escaped\\:Key"]), [["Escaped\\:Key", "x\\#y"]]);
  assert.deepEqual(patchIoc(document, [{ key: "A", value: "2" }]), [{ key: "A", before: "1", after: "2" }]);
  assert.equal(serializeIoc(document), source.replace("A=1", "A=2"));
});

test("patch rejects duplicate and ambiguous properties", () => {
  assert.throws(() => patchIoc(parseIoc("A=1\nA=2\n"), [{ key: "A", value: "3" }]), /duplicate/);
  assert.throws(() => patchIoc(parseIoc("A=1\n"), [{ key: "A", value: "2" }, { key: "A", remove: true }]), /multiple operations/);
});

test("adding and removing properties preserves final-newline style", () => {
  const withEol = parseIoc("A=1\r\n");
  patchIoc(withEol, [{ key: "B", value: "2" }]);
  assert.equal(serializeIoc(withEol), "A=1\r\nB=2\r\n");

  const withoutEol = parseIoc("A=1\nB=2");
  patchIoc(withoutEol, [{ key: "B", remove: true }]);
  assert.equal(serializeIoc(withoutEol), "A=1");
});

test("discovery skips build metadata and path containment rejects escapes", async () => {
  const root = await temporary();
  try {
    await mkdir(join(root, "ecu", "cube"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "ecu", "cube", "x.ioc"), "A=1\n");
    await writeFile(join(root, ".git", "ignored.ioc"), "A=1\n");
    assert.deepEqual(await discoverIocFiles(root), ["ecu/cube/x.ioc"]);
    await assert.rejects(() => containedPath(root, "../outside.ioc", ".ioc"), /escapes/);
    await assert.rejects(() => containedPath(root, "ecu/cube/x.ioc\nexit", ".ioc"), /line breaks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executable discovery supports environment installation directories", async () => {
  const root = await temporary();
  try {
    const executable = join(root, "STM32CubeMX");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    assert.equal(await discoverExecutable({ STM32CUBEMX_PATH: root, PATH: "" }, "linux"), executable);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI script quotes portable paths and validation requires explicit OK", async () => {
  assert.match(cubeScript("/tmp/space here/a.ioc", true), /config load "\/tmp\/space here\/a\.ioc"/);
  const good = await runCubeMx("fake", cubeScript("/tmp/a.ioc"), async () => ({ stdout: "OK\nBye bye", stderr: "", code: 0 }));
  assert.equal(good.ok, true);
  const bad = await runCubeMx("fake", cubeScript("/tmp/a.ioc"), async () => ({ stdout: "KO\nBye bye", stderr: "", code: 0 }));
  assert.equal(bad.ok, false);
  const windowsBad = await runCubeMx("fake", cubeScript("C:\\tmp\\a.ioc"), async () => ({ stdout: "OK\r\nKO\r\n", stderr: "", code: 0 }));
  assert.equal(windowsBad.ok, false);
});

test("preview generation is isolated and reports changes", async () => {
  const root = await temporary();
  const project = join(root, "project");
  await mkdir(project);
  const ioc = join(project, "demo.ioc");
  await writeFile(ioc, "ProjectManager.KeepUserCode=true\n");
  await writeFile(join(project, "BUILD"), "repo-only\n");
  const fakeExec = async (_command: string, args: string[]) => {
    const script = await readFile(args[1], "utf8");
    const target = script.match(/config load "([^"]+)"/)?.[1];
    assert.ok(target);
    await writeFile(join(target.slice(0, target.lastIndexOf("/")), "generated.c"), "/* USER CODE BEGIN 0 */\n/* USER CODE END 0 */\n");
    return { stdout: "OK\nOK\n", stderr: "", code: 0 };
  };
  try {
    const result = await generateIsolated(ioc, "fake", fakeExec, { preview: true });
    assert.deepEqual(result.changes, [{ path: "generated.c", status: "created" }]);
    await assert.rejects(() => readFile(join(project, "generated.c")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation refuses project symlinks", async () => {
  const root = await temporary();
  const project = join(root, "project");
  await mkdir(project);
  const ioc = join(project, "demo.ioc");
  await writeFile(ioc, "A=1\n");
  await symlink(ioc, join(project, "alias.ioc"));
  try {
    await assert.rejects(() => generateIsolated(ioc, "fake", async () => ({ stdout: "OK\nOK\n", stderr: "", code: 0 }), { preview: true }), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applied generation restores changed repository metadata", async () => {
  const root = await temporary();
  const project = join(root, "project");
  await mkdir(project);
  const ioc = join(project, "demo.ioc");
  await writeFile(ioc, "A=1\n");
  await writeFile(join(project, "BUILD"), "keep\n");
  try {
    const generated = await generateIsolated(ioc, "fake", async () => {
      await writeFile(join(project, "BUILD"), "overwritten\n");
      await writeFile(join(project, "generated.c"), "generated\n");
      return { stdout: "OK\nOK\n", stderr: "", code: 0 };
    }, { preview: false });
    assert.equal(await readFile(join(project, "BUILD"), "utf8"), "keep\n");
    assert.deepEqual(generated.changes, [{ path: "generated.c", status: "created" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed applied generation restores the project", async () => {
  const root = await temporary();
  const project = join(root, "project");
  await mkdir(project);
  const ioc = join(project, "demo.ioc");
  await writeFile(ioc, "A=1\n");
  await writeFile(join(project, "BUILD"), "keep\n");
  try {
    await assert.rejects(() => generateIsolated(ioc, "fake", async () => {
      await writeFile(join(project, "partial.c"), "bad\n");
      return { stdout: "KO\n", stderr: "", code: 0 };
    }, { preview: false }), /restored/);
    assert.equal(await readFile(join(project, "BUILD"), "utf8"), "keep\n");
    await assert.rejects(() => readFile(join(project, "partial.c")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
