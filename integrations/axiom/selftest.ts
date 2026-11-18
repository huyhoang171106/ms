/**
 * One runnable check for the single `ms` tool.
 *
 *   bun integrations/axiom/selftest.ts
 *
 * Every assertion below is a property the tool promises an Axiom turn: one call does read+search+edit+shell,
 * the program result is what reaches the conversation, mutations need an approver, the test-guard holds,
 * undo restores the file, and the budgets stop a runaway program.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMsSystemPrompt, createMsTool, type MutationRequest } from "./ms-tool.js";
import { runProgram } from "./kernel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const msBin = path.join(repoRoot, "target/release/ms");
if (!fs.existsSync(msBin)) {
  console.error(`missing ${msBin}: run \`cargo build --release\` first`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ms-axiom-"));
const workspace = path.join(scratch, "workspace");
fs.cpSync(path.join(repoRoot, "tests/fixtures/small-repo"), workspace, { recursive: true });

const approved: MutationRequest[] = [];
const tool = createMsTool({
  msBin,
  workspaceRoot: workspace,
  stateDir: path.join(scratch, "state"),
  allowWrite: true,
  approve: async (request) => {
    approved.push(request);
    return request.command?.includes("forbidden") ? "not in this phase" : "allow";
  },
  limits: { timeoutMs: 5_000 },
});

let failures = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
};

await check("one call reads, searches, lists and opens a shell", async () => {
  const output = await tool.execute({
    code: `
      const file = await ms.read("src/lib.rs", { format: "hashline" });
      const hits = await ms.search("pub fn", { maxMatches: 5 });
      const tree = await ms.list("src", { recursive: true });
      const shell = await ms.exec("echo distiller-alive");
      return {
        revision: file.revision.length,
        hasTaggedLines: /^\\d+:[0-9a-f]{4}\\| /m.test(file.text),
        hitCount: hits.hits.length,
        files: tree.filter((entry) => !entry.endsWith("/")).length,
        exitCode: shell.exitCode,
        sawEcho: shell.output.includes("distiller-alive"),
      };
    `,
  });
  assert.match(output, /^ok · 4 calls/);
  assert.match(output, /"revision":\s*64/);
  assert.match(output, /"hasTaggedLines":\s*true/);
  assert.match(output, /"exitCode":\s*0/);
  assert.match(output, /"sawEcho":\s*true/);
  assert.equal(approved.length, 0, "a read-only program must not ask for approval");
});

await check("an approved edit is journaled and undo restores the file", async () => {
  const before = fs.readFileSync(path.join(workspace, "src/lib.rs"), "utf8");
  const output = await tool.execute({
    code: `
      const file = await ms.read("src/lib.rs");
      const edited = await ms.edit("src/lib.rs", {
        oldText: "pub fn add(a: i64, b: i64) -> i64 {",
        newText: "pub fn add(a: i64, b: i64) -> i64 { // single tool",
      }, { expectedRevision: file.revision });
      const undone = await ms.undo({ transactionId: edited.transactionId });
      return { transactionId: edited.transactionId, undone: undone.undoneTransactionId };
    `,
  });
  assert.match(output, /^ok · 3 calls/);
  assert.match(output, /"undone":\s*"tx-/);
  assert.equal(fs.readFileSync(path.join(workspace, "src/lib.rs"), "utf8"), before);
  assert.deepEqual(
    approved.map((request) => request.kind),
    ["edit", "undo"],
    "each mutation asks once, with its own kind",
  );
});

await check("a stale revision is refused instead of guessed", async () => {
  const output = await tool.execute({
    code: `
      const file = await ms.read("src/lib.rs");
      try {
        await ms.edit("src/lib.rs", { oldText: "fn main", newText: "fn main" }, { expectedRevision: "0".repeat(64) });
        return "edited with a wrong revision";
      } catch (error) {
        return { code: error.code, stale: String(error.message).includes("E_CONFLICT"), inSpec: await ms.edit("src/lib.rs", { oldText: "fn main", newText: "fn main", expectedRevision: "0".repeat(64) }).then(() => "edited", (e) => e.code) };
      }
    `,
  });
  assert.match(output, /^ok /);
  assert.match(output, /"stale":\s*true/);
  assert.match(output, /"code":\s*"E_CONFLICT"/);
  // A revision given inside a single edit spec is honoured, so a stale one is refused the same way.
  assert.match(output, /"inSpec":\s*"E_CONFLICT"/);
});

await check("a revision misplaced into the edit spec (single or array) is hoisted and applied", async () => {
  const output = await tool.execute({
    code: `
      await ms.write("src/hoist.txt", "a\\nb\\n");
      const f = await ms.read("src/hoist.txt");
      const single = await ms.edit("src/hoist.txt", { expectedRevision: f.revision, oldText: "a\\n", newText: "A\\n" });
      const arr = await ms.edit("src/hoist.txt", [{ expectedRevision: single.revision, oldText: "b\\n", newText: "B\\n" }]);
      const missing = await ms.edit("src/hoist.txt", { oldText: "A", newText: "a" }).then(() => "edited", (e) => e.message);
      return { text: (await ms.read("src/hoist.txt")).text, arrOk: arr.revision.length === 64, missing };
    `,
  });
  assert.match(output, /"text":\s*"A\\nB\\n"/);
  assert.match(output, /"arrOk":\s*true/);
  assert.match(output, /\{expectedRevision:\(await ms\.read\(path\)\)\.revision\}/);
});

await check("existing files require a revision for every mutation", async () => {
  for (const name of ["write", "edit", "delete", "rename", "batch"]) {
    fs.writeFileSync(path.join(workspace, `src/revision-${name}.txt`), "original\n");
  }
  const output = await tool.execute({ code: `
    const ops = [
      () => ms.write('src/revision-write.txt', 'changed', {overwrite:true}),
      () => ms.edit('src/revision-edit.txt', {oldText:'original',newText:'changed'}),
      () => ms.rm('src/revision-delete.txt'),
      () => ms.mv('src/revision-rename.txt', 'src/revision-renamed.txt'),
      () => ms.batch([{kind:'write_file',path:'src/revision-batch.txt',content:'changed',overwrite:true}]),
    ];
    const refused=[];
    for (const op of ops) { try { await op(); refused.push(false); } catch { refused.push(true); } }
    return refused;
  ` });
  assert.equal((output.match(/true/g) ?? []).length, 5);
  for (const name of ["write", "edit", "delete", "rename", "batch"]) {
    assert.equal(fs.readFileSync(path.join(workspace, `src/revision-${name}.txt`), "utf8"), "original\n");
  }
});

await check("matching revisions permit changes and stale revisions are rejected", async () => {
  fs.writeFileSync(path.join(workspace, "src/revision-roundtrip.txt"), "one\n");
  const output = await tool.execute({ code: `
    const before = await ms.read('src/revision-roundtrip.txt');
    const wrote = await ms.write('src/revision-roundtrip.txt', 'two\\n', {expectedRevision:before.revision});
    let stale = false;
    try { await ms.rm('src/revision-roundtrip.txt', {expectedRevision:before.revision}); } catch (e) { stale = e.code === 'E_CONFLICT'; }
    const edited = await ms.edit('src/revision-roundtrip.txt', {oldText:'two',newText:'three'}, {expectedRevision:wrote.revision});
    const removed = await ms.rm('src/revision-roundtrip.txt', {expectedRevision:edited.revision});
    return {stale, removed:!!removed.transactionId};
  ` });
  assert.match(output, /"stale":\s*true/);
  assert.match(output, /"removed":\s*true/);
  assert.equal(fs.existsSync(path.join(workspace, "src/revision-roundtrip.txt")), false);
});

await check("the test-guard refuses a weakened test file", async () => {
  const output = await tool.execute({
    code: `
      await ms.write("tests/test_math.py", "def test_add():\\n    assert 1 + 1 == 2\\n");
      try {
        await ms.edit("tests/test_math.py", { oldText: "    assert 1 + 1 == 2", newText: "    pass" });
        return "weakened the test";
      } catch (error) {
        return { blocked: /test-guard/.test(String(error.message)) };
      }
    `,
  });
  assert.match(output, /"blocked":\s*true/);
  assert.match(fs.readFileSync(path.join(workspace, "tests/test_math.py"), "utf8"), /assert 1 \+ 1 == 2/);
});

await check("a denied mutation never reaches the workspace", async () => {
  const output = await tool.execute({
    code: `
      try {
        await ms.exec("forbidden-command");
        return "ran a denied command";
      } catch (error) {
        return { refused: String(error.message) };
      }
    `,
  });
  assert.match(output, /not in this phase/);
});

await check("a runaway program is stopped by the deadline", async () => {
  const output = await tool.execute({ code: "while (true) {}\nreturn 1;" });
  assert.match(output, /^Error: /);
});

await check("the host call budget is enforced", async () => {
  const bounded = createMsTool({
    msBin,
    workspaceRoot: workspace,
    limits: { maxCalls: 2, timeoutMs: 5_000 },
  });
  const output = await bounded.execute({
    code: `
      for (let i = 0; i < 5; i++) await ms.read("src/lib.rs", { lineCount: 1 });
      return "budget not enforced";
    `,
  });
  await bounded.close();
  assert.match(output, /host call budget exhausted \(2 per program\)/);
});

await check("without an approver a mutation is refused, not silently allowed", async () => {
  const unattended = createMsTool({
    msBin,
    workspaceRoot: workspace,
    stateDir: path.join(scratch, "state2"),
    allowWrite: true,
    limits: { timeoutMs: 5_000 },
  });
  const output = await unattended.execute({ code: `await ms.write("src/lib.rs", ""); return "wrote";` });
  await unattended.close();
  assert.match(output, /no approver installed/);
  assert.match(fs.readFileSync(path.join(workspace, "src/lib.rs"), "utf8"), /pub fn add/);
});

await check("three jobs run in parallel inside one call", async () => {
  const started = Date.now();
  const output = await tool.execute({
    code: `
      const ids = ["a", "b", "c"].map((name) => ms.start(\`sleep 0.4 && echo \${name}\`));
      const handles = await Promise.all(ids);
      const done = await Promise.all(handles.map((job) => ms.wait(job.id)));
      const tails = (await Promise.all(handles.map((job) => ms.tail(job.id, 5)))).map((t) => t.lines.trim());
      return { exits: done.map((job) => job.exitCode), tails, running: done.filter((job) => job.running).length };
    `,
  });
  const elapsed = Date.now() - started;
  assert.match(output, /"exits":\s*\[\s*0,\s*0,\s*0\s*\]/);
  assert.match(output, /"tails":\s*\[\s*"a",\s*"b",\s*"c"\s*\]/);
  assert.ok(elapsed < 1_400, `three 400ms jobs finished in ${elapsed}ms, which is not parallelism`);
});

await check("a job started in one call is still readable in the next", async () => {
  const first = await tool.execute({
    code: `
      const job = await ms.start("sleep 0.7 && echo SURVIVED-THE-CELL");
      return { id: job.id, running: job.running };
    `,
  });
  const id = /"id":\s*"(job-\d+)"/.exec(first)?.[1];
  assert.ok(id, `first call did not return a job id: ${first}`);
  const second = await tool.execute({
    code: `
      const done = await ms.wait("${id}", { timeoutMs: 10_000 });
      const tail = await ms.tail("${id}", 5);
      return { exitCode: done.exitCode, tail: tail.lines.trim() };
    `,
  });
  assert.match(second, /"tail":\s*"SURVIVED-THE-CELL"/);
});

await check("tail, head and grep return exactly the bytes asked for", async () => {
  const output = await tool.execute({
    code: `
      const job = await ms.start("for i in \\$(seq 1 200); do echo line-\\$i; done");
      await ms.wait(job.id, { timeoutMs: 20_000 });
      const [tail, head, hit, missing, poll] = await Promise.all([
        ms.tail(job.id, 2), ms.head(job.id, 2), ms.grep(job.id, "line-137$"), ms.grep(job.id, "line-999"), ms.poll(job.id),
      ]);
      return { tail: tail.lines, head, hit: hit.matches, missing: missing.matches.length, lines: poll.lines };
    `,
  });
  // JSON escapes the newlines, so the rendered text carries a literal backslash-n.
  assert.match(output, /"tail":\s*"line-199\\nline-200"/);
  assert.match(output, /"head":\s*"line-1\\nline-2"/);
  assert.match(output, /"hit":\s*\[\s*"137: line-137"\s*\]/);
  assert.match(output, /"missing":\s*0/);
  assert.match(output, /"lines":\s*200/);
});

await check("kill stops the whole process group", async () => {
  const output = await tool.execute({
    code: `
      const job = await ms.start("sleep 30");
      const killed = await ms.kill(job.id);
      const done = await ms.wait(job.id, { timeoutMs: 5_000 });
      return { killedRunning: killed.running, running: done.running, exitCode: done.exitCode };
    `,
  });
  assert.match(output, /"running":\s*false/);
  assert.doesNotMatch(output, /"exitCode":\s*0/);
});

await check("read reports pagination metadata and batch supports edit + write", async () => {
  const output = await tool.execute({
    code: `
      const lines = Array.from({ length: 12 }, (_, i) => "line-" + (i + 1)).join("\\n") + "\\n";
      await ms.write("src/paginated.txt", lines);
      const part1 = await ms.read("src/paginated.txt", { startLine: 1, lineCount: 5 });
      const part2 = await ms.read("src/paginated.txt", { startLine: part1.endLine + 1, lineCount: 20 });
      const pastEof = await ms.read("src/paginated.txt", { startLine: 999, lineCount: 10 });
      const emptyWindow = await ms.read("src/paginated.txt", { startLine: 7, lineCount: 0 });
      const batch = await ms.batch([
        { kind: "edit", path: "src/paginated.txt", oldText: "line-1\\n", newText: "LINE-1\\n", expectedRevision: part1.revision },
        { kind: "write", path: "src/extra.txt", text: "extra\\n" },
      ]);
      const chained = await ms.edit("src/paginated.txt", { oldText: "line-2\\n", newText: "LINE-2\\n" }, { expectedRevision: "rev:" + batch.results[0].afterRevision });
      const chained2 = await ms.edit("src/paginated.txt", { oldText: "line-3\\n", newText: "LINE-3\\n" }, { expectedRevision: chained.revision });
      const outline = await ms.outline("src", { maxSymbolsPerFile: 5 });
      const fileOutline = await ms.outline("src/lib.rs", { maxSymbolsPerFile: 5 });
      const ctx = await ms.context("src/lib.rs", { line: 1, radius: 5 });
      return {
        p1: { startLine: part1.startLine, endLine: part1.endLine, truncated: part1.truncated },
        p2: { truncated: Boolean(part2.truncated) },
        eofTruncated: Boolean(pastEof.truncated),
        emptyWindow: { truncated: emptyWindow.truncated, next: emptyWindow.nextStartLine },
        applied: batch.operationsApplied,
        chainedOk: typeof chained2.revision === "string" && chained2.revision.length === 64,
        outlineCount: outline.length,
        fileOutlineCount: fileOutline.length,
        hasCtxSnippet: typeof ctx.hashlineSnippet === "string" && ctx.hashlineSnippet.length > 0,
      };
    `,
  });
  assert.match(output, /"truncated":\s*true/);
  assert.match(output, /"truncated":\s*false/);
  assert.match(output, /"eofTruncated":\s*false/);
  assert.match(output, /"emptyWindow":\s*\{\s*"truncated":\s*true,\s*"next":\s*7/);
  assert.match(output, /"applied":\s*2/);
  assert.match(output, /"chainedOk":\s*true/);
  assert.match(output, /"fileOutlineCount":\s*1/);
  assert.match(output, /"hasCtxSnippet":\s*true/);
});

await check("un-awaited host calls do not leak unhandled rejections on abort", async () => {
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const output = await tool.execute({
      code: `
        const pending = ms.read("src/lib.rs");
        return pending.text.length;
      `,
    });
    assert.match(output, /^Error: TypeError:/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(unhandled, false, "un-awaited host call leaked an unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

await check("replaceAll edit, cache-hiding list, search trimming, and buildMsSystemPrompt work", async () => {
  const prompt = buildMsSystemPrompt("Axiom running with bash and file tools. Modify with the \"edit\" or \"write_file\" tool. Use read_file on skills.");
  assert.doesNotMatch(prompt, /with bash and file tools|with the "edit" or "write_file" tool|use read_file/);
  assert.match(prompt, /Code-Mode Workflow/);

  const output = await tool.execute({
    code: `
      await ms.write("src/__pycache__/ignored.pyc", "x");
      await ms.write("src/multi.txt", "alpha beta\\nalpha gamma\\n" + "z".repeat(300) + " alpha\\n");
      const list = await ms.list("src", { recursive: true });
      const search = await ms.search("alpha", { path: "src/multi.txt" });
      const original = await ms.read("src/multi.txt", { lineCount: 1 });
      const ed = await ms.edit("src/multi.txt", { oldText: "alpha", newText: "OMEGA", replaceAll: true }, { expectedRevision: original.revision });
      const rd = await ms.read("src/multi.txt", { startLine: 1, lineCount: 1 });
      return {
        hasPyc: list.some((e) => e.includes("__pycache__") || e.endsWith(".pyc")),
        count: search.hits.length,
        maxTextLen: Math.max(...search.hits.map((h) => h.text.length)),
        editsApplied: ed.editsApplied,
        nextStartLine: rd.nextStartLine,
      };
    `,
  });
  assert.match(output, /"hasPyc":\s*false/);
  assert.match(output, /"count":\s*3/);
  assert.match(output, /"editsApplied":\s*3/);
  assert.match(output, /"nextStartLine":\s*2/);
  const lenMatch = /"maxTextLen":\s*(\d+)/.exec(output);
  assert.ok(lenMatch && Number(lenMatch[1]) <= 201, `expected trimmed search hit <= 201, got ${output}`);
});

await check("ms.inputs delivers unescaped payloads cleanly and rejects undefined batch content", async () => {
  const rawJs = "export const msg = `hello ${world}`;\n// quote ' and \" and \\\\";
  const output = await tool.execute({
    inputs: { "src/templated.js": rawJs },
    code: `
      await ms.batch(Object.entries(ms.inputs).map(([path, content]) => ({ kind: "write_file", path, content })));
      const rd = await ms.read("src/templated.js", { format: "json" });
      return { len: rd.text.length, exact: rd.text === ms.inputs["src/templated.js"] };
    `,
  });
  assert.match(output, /"exact":\s*true/);

  const badBatch = await tool.execute({
    inputs: { a: "ok" },
    code: `await ms.batch([{ kind: "write_file", path: "src/typo.js", content: ms.inputs.missing }]);`,
  });
  assert.match(badBatch, /requires string content \(got undefined/);
});

await check("ms.batch protects existing tests and permits new test files", async () => {
  await tool.execute({
    code: `
      await ms.write("src/helper.py", "def val(): return 1\\n");
      await ms.write("tests/test_helper.py", "from src.helper import val\\ndef test_val():\\n    assert val() == 1\\n");
    `,
  });
  const blocked = await tool.execute({
    code: `
      try {
        await ms.batch([
          { kind: "write_file", path: "src/new_helper.py", content: "def val(): return 1\\n" },
          { kind: "edit", path: "tests/test_helper.py", oldText: "    assert val() == 1", newText: "    pass" },
        ]);
        return { blocked: false };
      } catch (e) {
        return { blocked: /test-guard/.test(String(e.message)) };
      }
    `,
  });
  assert.match(blocked, /"blocked":\s*true/);
  assert.equal(fs.existsSync(path.join(workspace, "src/new_helper.py")), false, "failed test-guard must stop before mutating any file in batch");

  const allowed = await tool.execute({
    code: `
      const b = await ms.batch([
        { kind: "write_file", path: "src/new_helper.py", content: "def val(): return 1\\n" },
        { kind: "write_file", path: "tests/test_new_helper.py", content: "def test_new(): assert True\\n" },
      ]);
      return { applied: b.operationsApplied };
    `,
  });
  assert.match(allowed, /"applied":\s*2/);
  assert.match(fs.readFileSync(path.join(workspace, "tests/test_new_helper.py"), "utf8"), /test_new/);
});

await check("sandbox isolates the workspace, secrets, and shell writes", async () => {
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET=do-not-leak\n");
  fs.writeFileSync(path.join(scratch, "outside.txt"), "outside-secret\n");
  fs.linkSync(path.join(scratch, "outside.txt"), path.join(workspace, "hardlinked.txt"));
  fs.symlinkSync(path.join(scratch, "outside.txt"), path.join(workspace, "linked.txt"));
  const before = fs.readFileSync(path.join(workspace, "src/lib.rs"), "utf8");
  const output = await tool.execute({ code: `
    const guest = require('node:fs').existsSync(${JSON.stringify(workspace)});
    const res = await ms.exec("test ! -e .env && test ! -e ../outside.txt && test ! -e hardlinked.txt && test ! -e linked.txt && echo changed > src/lib.rs && cat src/lib.rs");
    return {guest, exit: res.exitCode, output: res.output};
  ` });
  assert.match(output, /"guest":\s*false/);
  assert.match(output, /"exit":\s*0/);
  assert.match(output, /changed/);
  assert.equal(fs.readFileSync(path.join(workspace, "src/lib.rs"), "utf8"), before);
});

await check("test guard prevents partial and normalized test mutations", async () => {
  const output = await tool.execute({ code: `
    const failures = [];
    for (const fn of [
      () => ms.edit('tests/test_helper.py/.', {oldText:'== 1', newText:'== 2'}),
      () => ms.mv('src/helper.py', 'tests/test_helper.py', {overwrite:true}),
      () => ms.write('tests/test_helper.py', 'def test_val(): pass'),
      async () => { const f = await ms.read('tests/test_helper.py'); return ms.write('tests/test_helper.py', 'def test_val(): pass', {expectedRevision:f.revision}); },
    ]) { try { await fn(); failures.push(false); } catch { failures.push(true); } }
    return failures;
  ` });
  assert.equal((output.match(/true/g) ?? []).length, 4);
});

await check("undo cannot remove a newly created test", async () => {
  const output = await tool.execute({ code: `
    const created = await ms.write('tests/test_undo_guard.py', 'def test_ok(): assert True');
    try { await ms.undo({transactionId: created.transactionId}); return 'not blocked'; }
    catch (error) { return String(error.message); }
  ` });
  assert.match(output, /test-guard/);
  assert.ok(fs.existsSync(path.join(workspace, "tests/test_undo_guard.py")));
});

await check("output cap includes console logs", async () => {
  const output = await tool.execute({ code: `for (let i=0;i<100;i++) console.log('x'.repeat(24576)); return 'ok';` });
  assert.ok(Buffer.byteLength(output) <= 24 * 1024);
});

await check("sandbox exposes installed JavaScript runtimes without exposing home", async () => {
  const output = await tool.execute({ code: `
    const node = await ms.exec(['node', '-e', 'console.log(6 * 7)']);
    const bun = await ms.exec(['bun', '-e', 'console.log(6 * 7)']);
    return { exit: node.exitCode, output: node.output, bunExit: bun.exitCode, bunOutput:bun.output };
  ` });
  assert.match(output, /"exit":\s*0/);
  assert.match(output, /42/);
  assert.match(output, /"bunExit":\s*0/);
});

await check("sandbox can run the installed Python test runner", async () => {
  const output = await tool.execute({ code: `
    const r = await ms.exec(['python3', '-m', 'pytest', '-q', 'tests/test_math.py']);
    const direct = await ms.exec(['pytest', '-q', 'tests/test_math.py']);
    return {exit:r.exitCode, output:r.output, direct:direct.exitCode};
  ` });
  assert.match(output, /"exit":\s*0/);
  assert.match(output, /1 passed/);
  assert.match(output, /"direct":\s*0/);
});

await check("sandbox can verify a real fixture before and after a revision-checked edit", async () => {
  const fixture = path.join(scratch, "medium-workspace");
  fs.cpSync(path.join(repoRoot, "benchmarks/fixtures/medium-repo-eval"), fixture, { recursive: true });
  const scenario = createMsTool({
    msBin, workspaceRoot: fixture, stateDir: path.join(scratch, "medium-state"),
    allowWrite: true, allowUnapprovedWrites: true, limits: { timeoutMs: 20_000 },
  });
  try {
    const output = await scenario.execute({ code: `
      const command = ['python3', '-m', 'pytest', '-q', 'tests/test_export.py'];
      const before = await ms.exec(command);
      const file = await ms.read('taskflow/plugins/csv_export.py');
      await ms.edit('taskflow/plugins/csv_export.py', {
        oldText: 't.metadata.get("source", "")',
        newText: '(t.metadata or {}).get("source", "")',
      }, {expectedRevision:file.revision});
      const after = await ms.exec(command);
      return {before:before.exitCode, after:after.exitCode, output:after.output};
    ` });
    assert.match(output, /"before":\s*1/);
    assert.match(output, /"after":\s*0/);
    assert.match(output, /41 passed/);
    const oracle = execFileSync("python3", ["-m", "pytest", "-q", "tests/test_export.py"], { cwd: fixture, encoding: "utf8" });
    assert.match(oracle, /41 passed/);
  } finally { await scenario.close(); }
});

await check("a truncated listing is not presented as a complete result", async () => {
  const output = await tool.execute({ code: `
    try { await ms.list('.', {recursive:true, maxEntries:1}); return 'complete'; }
    catch (error) { return String(error.message); }
  ` });
  assert.match(output, /truncat/i);
});

await check("read returns exact file text (EOL, trailing newline) and flags a BOM", async () => {
  fs.writeFileSync(path.join(workspace, "src/metadata.txt"), Buffer.from("\ufeffone\r\ntwo\r\n", "utf8"));
  fs.writeFileSync(path.join(workspace, "src/open-end.txt"), "a\nb");
  const output = await tool.execute({ code: `
    const r = await ms.read('src/metadata.txt', {lineCount:2});
    const first = await ms.read('src/metadata.txt', {lineCount:1});
    const open = await ms.read('src/open-end.txt');
    return {bom:r.hasBom, exact:r.text === 'one\\r\\ntwo\\r\\n', window:first.text === 'one\\r\\n' && first.nextStartLine === 2, openEnd:open.text === 'a\\nb'};
  ` });
  assert.match(output, /"bom":\s*true/);
  assert.match(output, /"exact":\s*true/);
  assert.match(output, /"window":\s*true/);
  assert.match(output, /"openEnd":\s*true/);
});

await check("search snippets retain matches after long Unicode prefixes", async () => {
  fs.writeFileSync(path.join(workspace, "src/long-search.txt"), "🙂".repeat(400) + "NEEDLE_123" + "x".repeat(400));
  const output = await tool.execute({ code: `
    const a = await ms.search('needle_123', {path:'src/long-search.txt', caseSensitive:false});
    const b = await ms.search('NEEDLE_[0-9]+', {path:'src/long-search.txt', regex:true});
    return {literal:a.hits[0].text.includes('NEEDLE_123'), regex:b.hits[0].text.includes('NEEDLE_123'), trimmed:a.hits[0].textTruncated};
  ` });
  assert.match(output, /"literal":\s*true/);
  assert.match(output, /"regex":\s*true/);
  assert.match(output, /"trimmed":\s*true/);
});

await check("long command output keeps the first error, tail and truncation status", async () => {
  const output = await tool.execute({ code: `
    const r = await ms.exec(['python3', '-c', "print('FIRST_ERROR'); print('x' * 25000); print('LAST_LINE')"]);
    return {output:r.output, truncated:r.truncated};
  ` });
  assert.match(output, /FIRST_ERROR/);
  assert.match(output, /LAST_LINE/);
  assert.match(output, /"truncated":\s*true/);
});

await check("command output preserves UTF-8 split across pipe chunks", async () => {
  const output = await tool.execute({ code: `
    const script = "const b=Buffer.from('🙂'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),100)";
    const r = await ms.exec(['node','-e',script]);
    return {exit:r.exitCode, output:r.output};
  ` });
  assert.match(output, /"exit":\s*0/);
  assert.match(output, /🙂/);
  assert.doesNotMatch(output, /�/);
});

await check("large job output does not duplicate overlapping head and tail", async () => {
  const output = await tool.execute({ code: `
    const command = 'node -e ' + JSON.stringify("for(let i=0;i<5800;i++) console.log('N'+String(i).padStart(5,'0')+':'+'.'.repeat(90))");
    const job = await ms.start(command);
    await ms.wait(job.id, {timeoutMs:10000});
    const result = await ms.output(job.id, {maxBytes:1048576});
    const lines = result.text.split('\\n').filter(line => /^N[0-9]{5}:/.test(line));
    return {duplicates: lines.length - new Set(lines).size, truncated:result.truncated};
  ` });
  assert.match(output, /"duplicates":\s*0/);
});

await check("expensive log patterns cannot block the tool", async () => {
  const started = Date.now();
  const output = await tool.execute({ code: `
    const command = 'node -e ' + JSON.stringify("console.log('a'.repeat(30000)+'x')");
    const job = await ms.start(command);
    await ms.wait(job.id, {timeoutMs:5000});
    let outcome = 'searched';
    try { await ms.grep(job.id, '(a+)+$'); } catch (error) { outcome = String(error.message); }
    const file = await ms.read('src/lib.rs', {lineCount:1});
    return {outcome, alive:!!file.revision};
  ` });
  assert.match(output, /"alive":\s*true/);
  assert.ok(Date.now() - started < 4000, "log search blocked the tool deadline");
});

await check("log search reports when the middle of the log was discarded", async () => {
  const output = await tool.execute({ code: `
    const command = 'node -e ' + JSON.stringify("process.stdout.write('a'.repeat(750000)+'NEEDLE'+'b'.repeat(750000))");
    const job = await ms.start(command);
    await ms.wait(job.id, {timeoutMs:10000});
    const found = await ms.grep(job.id, 'NEEDLE');
    const log = await ms.log(job.id, {grep:'NEEDLE'});
    return {count:found.matches.length, truncated:found.truncated, log};
  ` });
  assert.match(output, /"count":\s*0/);
  assert.match(output, /"truncated":\s*true/);
  assert.match(output, /log search incomplete/);
});

await check("command timeout is reported explicitly", async () => {
  const output = await tool.execute({ code: `
    const r = await ms.exec(['sh', '-c', 'sleep 2'], {timeoutMs:100});
    return {exit:r.exitCode, timedOut:r.timedOut};
  ` });
  assert.match(output, /"exit":\s*124/);
  assert.match(output, /"timedOut":\s*true/);
});

await check("program timeout interrupts a pending approval", async () => {
  const root = path.join(scratch, "pending-approval");
  fs.mkdirSync(root);
  const bounded = createMsTool({
    msBin, workspaceRoot: root, stateDir: path.join(scratch, "pending-approval-state"),
    allowWrite: true, approve: () => new Promise(() => {}), limits: {timeoutMs:150},
  });
  try {
    const output = await Promise.race([
      bounded.execute({code:"await ms.write('x.txt', 'x')"}),
      new Promise<string>(resolve => setTimeout(() => resolve("hung"), 1000)),
    ]);
    assert.match(output, /exceeded 150ms/);
    assert.equal(fs.existsSync(path.join(root, "x.txt")), false);
  } finally { await bounded.close(); }
});

await check("program timeout interrupts a background-job wait", async () => {
  const root = path.join(scratch, "pending-wait");
  fs.mkdirSync(root);
  const bounded = createMsTool({
    msBin, workspaceRoot: root, stateDir: path.join(scratch, "pending-wait-state"),
    allowWrite: true, allowUnapprovedWrites:true, limits: {timeoutMs:200},
  });
  try {
    const output = await Promise.race([
      bounded.execute({code:"const j = await ms.start('sleep 10'); await ms.wait(j.id)"}),
      new Promise<string>(resolve => setTimeout(() => resolve("hung"), 1200)),
    ]);
    assert.match(output, /exceeded 200ms/);
  } finally { await bounded.close(); }
});

await check("reviewer has no shell or write capabilities and cannot read another session's log", async () => {
  const reviewer = createMsTool({ msBin, workspaceRoot: workspace, readOnly: true });
  try {
    const output = await reviewer.execute({ code: `
      let logDenied = false;
      try { await ms.log('job-1'); } catch { logDenied = true; }
      return {exec: typeof ms.exec, write: typeof ms.write, logDenied};
    ` });
    assert.match(output, /"exec":\s*"undefined"/);
    assert.match(output, /"write":\s*"undefined"/);
    assert.match(output, /"logDenied":\s*true/);
  } finally { await reviewer.close(); }
});

await check("missing sandbox runtime fails closed", async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    let called = false;
    const result = await runProgram("await ms.touch()", () => ({ touch: async () => { called = true; } }));
    assert.equal(result.ok, false);
    assert.match(result.output, /sandbox unavailable/);
    assert.equal(called, false);
  } finally { process.env.PATH = previous; }
});

await check("in-workspace absolute paths normalize cleanly while outside paths remain denied", async () => {
  const output = await tool.execute({
    code: `
      const ws = ${JSON.stringify(workspace)};
      const insideFile = ${JSON.stringify(path.join(workspace, "src/lib.rs"))};
      const entries = await ms.list(ws);
      const rd = await ms.read(insideFile, { lineCount: 1 });
      let outsideDenied = false;
      try {
        await ms.read("/tmp/outside-ms-selftest.txt");
      } catch (e) {
        outsideDenied = /E_POLICY_DENIED/.test(String(e.message));
      }
      return { hasSrc: entries.includes("src/"), samePath: rd.path === "src/lib.rs", outsideDenied };
    `,
  });
  assert.match(output, /"hasSrc":\s*true/);
  assert.match(output, /"samePath":\s*true/);
  assert.match(output, /"outsideDenied":\s*true/);
});

await tool.close();
fs.rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
