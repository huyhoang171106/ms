import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPythonRepl, hostPython, pythonSandbox, repoMap, stageReplPytest } from './python_repl.js';
import { runPytest } from './pytest_oracle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-repl-check-'));
const workspace = path.join(root, 'workspace');
const state = path.join(root, 'state');
fs.mkdirSync(workspace);
fs.mkdirSync(state);
try {
  stageReplPytest(workspace, state);
  const repl = createPythonRepl(workspace, state);
  try {
    assert.equal(await repl.execute({ code: 'from pathlib import Path\ndef make_test():\n    return Path("test_one.py").write_text("def test_one(): assert True\\n")' }), '(no output)');
    assert.match(await repl.execute({ code: 'make_test()' }), /^\d+\n$/);
    assert.equal(await repl.execute({ code: 'Path("test_one.py").exists()' }), 'True\n');
    assert.equal(await repl.execute({ code: 'import asyncio\njob = asyncio.create_task(asyncio.sleep(0.01, result=42))' }), '(no output)');
    assert.equal(await repl.execute({ code: 'await job' }), '42\n');
    assert.match(await repl.execute({ code: 'raise ValueError("cell failure")' }), /Error:.*ValueError: cell failure/s);
    assert.match(await repl.execute({ code: 'value = "x" * 40000\nprint(value)' }), /output truncated/);
    assert.equal(await repl.execute({ code: 'import subprocess\n_ = subprocess.run(["echo", "raw stdout"])\nlen(value)' }), '40000\n');
    assert.deepEqual(await Promise.all([repl.execute({ code: 'n = 1' }), repl.execute({ code: 'n + 1' })]), ['(no output)', '2\n']);
    assert.equal(await repl.execute({ code: 'Path("a.py").write_text("x = 1\\ny = 2\\n")\nprint(sh("cat a.py"))' }), '[exit 0]\nx = 1\ny = 2\n\n');
    assert.match(await repl.execute({ code: 'patch({"a.py": [("x = 1", "x = 10"), ("y = 3", "y = 30")]})' }), /no files changed.*found 0 for 'y = 3'; closest line 2: 'y = 2'/s);
    assert.equal(await repl.execute({ code: 'patch({"a.py": [("x = 1", "x = 10"), ("y = 2", "y = 20")]})\nPath("a.py").read_text()' }), "'x = 10\\ny = 20\\n'\n");
    assert.equal(await repl.execute({ code: 'Path("b.py").write_text("import os\\ndef f():\\n    return os.sep + missing_name\\n")\nprint(lint("a.py", "b.py"))' }), "/workspace/b.py: undefined names ['missing_name']\n");
    assert.match(await repl.execute({ code: 'lint("a.py")' }), /ok: 1 files/);
    assert.equal(await repl.execute({ code: 'Path("two_test.py").write_text("import time\\ndef test_two():\\n    time.sleep(1)\\n    assert True\\n")\nprint(lint("two_test.py"))' }), '/workspace/two_test.py: +1 fixed sleep in a test; wait on the result or condition instead\n/workspace/two_test.py: +1 assert on a constant checks nothing; assert real behaviour\n');
    assert.equal(await repl.execute({ code: 'import os\nprint(os.environ["HOME"], Path("/home/hoang").exists())' }), '/tmp False\n');
    assert.equal(await repl.execute({ code: 'Path("g").mkdir()\nPath("g/c.py").write_text("def f():\\n    return old_name\\n")\nPath("g/k.pyx").write_text("cdef int x = 1\\n")\nsh("cd g && git init -q && git add c.py && git -c user.name=t -c user.email=t@t commit -qm init")\nPath("g/c.py").write_text("def f():\\n    return old_name + new_name\\n")\nprint(lint("g/c.py", "g/k.pyx"))' }), "/workspace/g/c.py: undefined names ['new_name'] (skipped non-Python: k.pyx)\n");
  } finally { await repl.close(); }
  const plain = createPythonRepl(workspace, state, { testShortcuts: false });
  try {
    assert.match(await plain.execute({ code: 'print(lint("two_test.py"))' }), /^ok: 1 files/);
  } finally { await plain.close(); }
  const fresh = createPythonRepl(workspace, state);
  try {
    assert.match(await fresh.execute({ code: 'print(lint("test_one.py", "two_test.py"))\nPath("two_test.py").unlink()' }), /^ok: 2 files/);
  } finally { await fresh.close(); }
  const bounded = createPythonRepl(workspace, state, { timeoutMs: 500 });
  try {
    const timedOut = bounded.execute({ code: 'from pathlib import Path\np = Path("attempts.txt")\nwith p.open("a") as f: f.write("once\\n")\nwhile True: pass' });
    const recovered = bounded.execute({ code: 'from pathlib import Path\nimport resource\nprint("p" in globals(), Path("attempts.txt").read_text().splitlines(), resource.getrlimit(resource.RLIMIT_NPROC))' });
    assert.match(await timedOut, /timed out.*not replayed/);
    assert.match(await recovered, /^\[Python kernel restarted; in-memory state was lost.*False \['once'\] \(256, 256\)/s);
    assert.equal(await bounded.execute({ code: '1' }), '1\n');
    assert.match(await bounded.execute({ code: 'import os\nos._exit(42)' }), /kernel exited.*42/);
    assert.match(await bounded.execute({ code: '2' }), /kernel restarted.*2\n$/s);
  } finally { await bounded.close(); }
  assert.match(await bounded.execute({ code: '1' }), /closed/);
  const systemPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(hostPython('/bundled/python3'), systemPython);
  const hosted = createPythonRepl(workspace, state, { host: { python: hostPython('/bundled/python3') } });
  try {
    assert.equal(await hosted.execute({ code: 'import os\nprint(sh("cat a.py").splitlines()[1], os.getcwd())\nprint(lint("b.py"))' }), `x = 10 ${fs.realpathSync(workspace)}\n${fs.realpathSync(workspace)}/b.py: undefined names ['missing_name']\n`);
    assert.ok(hosted.description.startsWith(`Run Python in ${fs.realpathSync(workspace)}.`) && !hosted.description.includes('No network'));
  } finally { await hosted.close(); }
  assert.match(repoMap(workspace), /^Repo map \(text files with line counts; Python 3[^)]*\):\n\.\/: .*a\.py 2/);
  assert.doesNotMatch(repoMap(workspace), /pytest/);
  const report = runPytest(workspace, 'python3', 10_000, (args, dir) => pythonSandbox(workspace, state, args, dir));
  assert.deepEqual(report.passed, ['test_one.py::test_one'], report.summary);
  console.log('persistent Python, workspace edits, isolated pytest: OK');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

// C_py system spec (Terminal-Bench runner): terse, carries env + stop rule, cwd filled by the runner.
{
  const { PYTHON_SYSTEM, PYTHON_DESCRIPTION } = await import('../integrations/axiom/cpy.ts');
  assert.ok(PYTHON_SYSTEM.length + PYTHON_DESCRIPTION.length < 1400, 'spec stays terse');
  assert.ok(PYTHON_SYSTEM.includes('{cwd}') && PYTHON_SYSTEM.includes('stop:') && PYTHON_SYSTEM.includes('every branch'));
}

{
  const { trimOldToolOutputs } = await import('../integrations/axiom/cpy.ts');
  const big = 'x'.repeat(10000);
  const msgs = [{ role: 'user', content: big }, { role: 'tool', content: big }, { role: 'tool', content: 'short' }, { role: 'tool', content: big }, { role: 'tool', content: big }];
  const t = trimOldToolOutputs(msgs);
  assert.ok(t[0].content === big && t[2].content === 'short' && t[3].content === big && t[4].content === big, 'user, short and last three kept');
  assert.ok(t[1].content.length < 2500 && t[1].content.includes('elided'), 'old long tool output clipped');
  assert.equal(msgs[1].content, big, 'input not mutated');
}

// TB kernel: a child reading stdin gets EOF instead of blocking on the open request pipe (lean26: `sed -n 1p` with no file hung 900s).
{
  const { spawn } = await import('node:child_process');
  const k = spawn('python3', ['-u', path.join(import.meta.dirname, '../integrations/axiom/cpy_kernel.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = new Promise<string>((res) => k.stdout.once('data', (d) => res(String(d))));
  k.stdin.write(JSON.stringify({ code: 'import subprocess\ntry: print(subprocess.run(["sed","-n","1p"],capture_output=True,text=True,timeout=3).returncode)\nexcept subprocess.TimeoutExpired: print("blocked")' }) + '\n');
  const out = await reply; k.kill();
  assert.equal(out, '{"output": "0\\n"}\n', 'kernel stdin isolation');
}
