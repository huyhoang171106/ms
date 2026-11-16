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
      const file = await ms.read("src/lib.rs");
      const hits = await ms.search("pub fn", { maxMatches: 5 });
      const tree = await ms.list("src", { recursive: true });
      const shell = await ms.exec("echo distiller-alive");
      return {
        revision: file.revision.length,
        hasTaggedLines: /^\\d+:[0-9a-f]{4}\\| /m.test(file.text),
        hitCount: hits.hits.length,
        files: tree.filter((entry) => entry.kind === "file").length,
        exitCode: shell.exitCode,
        sawEcho: shell.output.includes("distiller-alive"),
      };
    `,
  });
  assert.match(output, /^ok · 4 calls/);
  assert.match(output, /"revision": 64/);
  assert.match(output, /"hasTaggedLines": true/);
  assert.match(output, /"exitCode": 0/);
  assert.match(output, /"sawEcho": true/);
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
  assert.match(output, /"undone": "tx-/);
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
        return { code: error.code, stale: String(error.message).includes("E_CONFLICT") };
      }
    `,
  });
  assert.match(output, /^ok /);
  assert.match(output, /"stale": true/);
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
  assert.match(output, /"blocked": true/);
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
  assert.match(output, /"exits": \[\s*0,\s*0,\s*0\s*\]/);
  assert.match(output, /"tails": \[\s*"a",\s*"b",\s*"c"\s*\]/);
  assert.ok(elapsed < 1_400, `three 400ms jobs finished in ${elapsed}ms, which is not parallelism`);
});

await check("a job started in one call is still readable in the next", async () => {
  const first = await tool.execute({
    code: `
      const job = await ms.start("sleep 0.7 && echo SURVIVED-THE-CELL");
      return { id: job.id, running: job.running };
    `,
  });
  const id = /"id": "(job-\d+)"/.exec(first)?.[1];
  assert.ok(id, `first call did not return a job id: ${first}`);
  const second = await tool.execute({
    code: `
      const done = await ms.wait("${id}", { timeoutMs: 10_000 });
      const tail = await ms.tail("${id}", 5);
      return { exitCode: done.exitCode, tail: tail.lines.trim() };
    `,
  });
  assert.match(second, /"tail": "SURVIVED-THE-CELL"/);
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
  assert.match(output, /"tail": "line-199\\nline-200"/);
  assert.match(output, /"head": "line-1\\nline-2"/);
  assert.match(output, /"hit": \[\s*"137: line-137"\s*\]/);
  assert.match(output, /"missing": 0/);
  assert.match(output, /"lines": 200/);
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
  assert.match(output, /"running": false/);
  assert.doesNotMatch(output, /"exitCode": 0/);
});

await check("read reports pagination metadata and batch supports edit + write", async () => {
  const output = await tool.execute({
    code: `
      const lines = Array.from({ length: 12 }, (_, i) => "line-" + (i + 1)).join("\\n") + "\\n";
      await ms.write("src/paginated.txt", lines);
      const part1 = await ms.read("src/paginated.txt", { startLine: 1, lineCount: 5 });
      const part2 = await ms.read("src/paginated.txt", { startLine: part1.endLine + 1, lineCount: 20 });
      const pastEof = await ms.read("src/paginated.txt", { startLine: 999, lineCount: 10 });
      const batch = await ms.batch([
        { kind: "edit", path: "src/paginated.txt", oldText: "line-1\\n", newText: "LINE-1\\n" },
        { kind: "write", path: "src/extra.txt", text: "extra\\n" },
      ]);
      const chained = await ms.edit("src/paginated.txt", { oldText: "line-2\\n", newText: "LINE-2\\n" }, { expectedRevision: "rev:" + batch.results[0].afterRevision });
      const chained2 = await ms.edit("src/paginated.txt", { oldText: "line-3\\n", newText: "LINE-3\\n" }, { expectedRevision: chained.revision });
      const outline = await ms.outline("src", { maxSymbolsPerFile: 5 });
      const fileOutline = await ms.outline("src/lib.rs", { maxSymbolsPerFile: 5 });
      const ctx = await ms.context("src/lib.rs", { line: 1, radius: 5 });
      return {
        p1: { startLine: part1.startLine, endLine: part1.endLine, truncated: part1.truncated },
        p2: { startLine: part2.startLine, endLine: part2.endLine, truncated: part2.truncated },
        eofTruncated: pastEof.truncated,
        applied: batch.operationsApplied,
        chainedOk: typeof chained2.revision === "string" && chained2.revision.length === 64,
        outlineCount: outline.length,
        fileOutlineCount: fileOutline.length,
        hasCtxSnippet: typeof ctx.hashlineSnippet === "string" && ctx.hashlineSnippet.length > 0,
      };
    `,
  });
  assert.match(output, /"truncated": true/);
  assert.match(output, /"truncated": false/);
  assert.match(output, /"eofTruncated": false/);
  assert.match(output, /"applied": 2/);
  assert.match(output, /"chainedOk": true/);
  assert.match(output, /"fileOutlineCount": 1/);
  assert.match(output, /"hasCtxSnippet": true/);
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
      const ed = await ms.edit("src/multi.txt", { oldText: "alpha", newText: "OMEGA", replaceAll: true });
      const rd = await ms.read("src/multi.txt", { startLine: 1, lineCount: 1 });
      return {
        hasPyc: list.some((e) => e.path.includes("__pycache__") || e.path.endsWith(".pyc")),
        count: search.count,
        maxTextLen: Math.max(...search.hits.map((h) => h.text.length)),
        editsApplied: ed.editsApplied,
        nextStartLine: rd.nextStartLine,
      };
    `,
  });
  assert.match(output, /"hasPyc": false/);
  assert.match(output, /"count": 3/);
  assert.match(output, /"editsApplied": 3/);
  assert.match(output, /"nextStartLine": 2/);
  const lenMatch = /"maxTextLen": (\d+)/.exec(output);
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
  assert.match(output, /"exact": true/);

  const badBatch = await tool.execute({
    inputs: { a: "ok" },
    code: `await ms.batch([{ kind: "write_file", path: "src/typo.js", content: ms.inputs.missing }]);`,
  });
  assert.match(badBatch, /requires string content \(got undefined/);
});

await check("ms.batch enforces test-guard per op and allows non-weakening atomic test edits", async () => {
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
  assert.match(blocked, /"blocked": true/);
  assert.equal(fs.existsSync(path.join(workspace, "src/new_helper.py")), false, "failed test-guard must stop before mutating any file in batch");

  const allowed = await tool.execute({
    code: `
      const b = await ms.batch([
        { kind: "write_file", path: "src/new_helper.py", content: "def val(): return 1\\n" },
        { kind: "edit", path: "tests/test_helper.py", oldText: "from src.helper import val", newText: "from src.new_helper import val" },
      ]);
      return { applied: b.operationsApplied };
    `,
  });
  assert.match(allowed, /"applied": 2/);
  assert.match(fs.readFileSync(path.join(workspace, "tests/test_helper.py"), "utf8"), /from src\.new_helper import val/);
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
      return { hasSrc: entries.some((e) => e.path === "src"), samePath: rd.path === "src/lib.rs", outsideDenied };
    `,
  });
  assert.match(output, /"hasSrc": true/);
  assert.match(output, /"samePath": true/);
  assert.match(output, /"outsideDenied": true/);
});

await tool.close();
fs.rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
