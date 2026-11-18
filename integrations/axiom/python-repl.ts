import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function pythonSandbox(workspace: string, stateDir: string, args: string[], reportDir?: string): string[] {
  const mounts = ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs'].filter((dir) => fs.existsSync(dir)).flatMap((dir) => ['--ro-bind', dir, dir]);
  return [
    '--unshare-all', '--unshare-user', '--disable-userns', '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
    '--setenv', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', '1', ...mounts, '--proc', '/proc', '--dev', '/dev',
    '--size', '67108864', '--tmpfs', '/tmp',
    ...(fs.existsSync(`${stateDir}/python`) ? ['--ro-bind', `${stateDir}/python`, '/python-deps', '--setenv', 'PYTHONPATH', '/python-deps'] : []),
    reportDir ? '--ro-bind' : '--bind', workspace, '/workspace', '--chdir', '/workspace',
    ...(reportDir && reportDir !== '/' ? ['--bind', reportDir, reportDir] : []),
    '--', '/usr/bin/prlimit', '--as=536870912', '--nproc=256', '--fsize=8388608', '--nofile=128', '--', '/usr/bin/python3', '-u', ...args,
  ];
}

const worker = String.raw`
import ast, asyncio, contextvars, io, json, os, sys, traceback, types

request_stream = os.fdopen(os.dup(0), encoding='utf-8')
with open(os.devnull, 'rb') as stdin:
    os.dup2(stdin.fileno(), 0)
reply = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)
sys.stdin = io.StringIO()
main = types.ModuleType('__main__')
sys.modules['__main__'] = main
scope = vars(main)
WORKSPACE = os.environ.get('REPL_WORKSPACE', '/workspace')

def sh(cmd, timeout=None):
    """Run a shell command in the workspace; return '[exit N]' followed by stdout and stderr."""
    import subprocess
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=WORKSPACE, timeout=timeout)
    return f'[exit {r.returncode}]\n{r.stdout}{r.stderr}'

def patch(changes):
    """Apply {path: [(old, new) or (old, new, count), ...]} exact replacements, all or nothing."""
    import difflib, pathlib
    planned, errors = {}, []
    for rel, pairs in changes.items():
        path = pathlib.Path(WORKSPACE, rel)
        try:
            text = path.read_text()
        except OSError as error:
            errors.append(f'{rel}: {error}')
            continue
        for old, new, *rest in pairs:
            want = rest[0] if rest else 1
            found = text.count(old)
            if found != want:
                hint = ''
                first = next((line.strip() for line in old.splitlines() if line.strip()), '')
                stripped = [line.strip() for line in text.splitlines()]
                close = difflib.get_close_matches(first, stripped, 1, 0.6) if found == 0 and first else []
                if close:
                    hint = f'; closest line {stripped.index(close[0]) + 1}: {close[0][:120]!r}'
                errors.append(f'{rel}: expected {want} match(es), found {found} for {old[:80]!r}{hint}')
                continue
            text = text.replace(old, new)
        planned[path] = text
    if errors:
        raise ValueError('patch not applied, no files changed:\n' + '\n'.join(errors))
    # ponytail: validated all-or-nothing, but the final writes are not transactional across files
    for path, text in planned.items():
        path.write_text(text)
    return f'patched {len(planned)} file(s)'

HONESTY = {
    'sleep': 'fixed sleep in a test; wait on the result or condition instead',
    'retry': 'retry/flaky marker masks a flaky test; fix the race instead',
    'timeout': 'raised test timeout; fix the slowness instead',
    'skip': 'test skipped or xfailed; make it pass or report it as failing',
    'trivial': 'assert on a constant checks nothing; assert real behaviour',
}

def is_test_file(path):
    return path.suffix == '.py' and (path.name.startswith('test_') or path.name.endswith('_test.py'))

def test_shortcuts(source):
    """Counts of test-honesty shortcuts inside test functions, keyed like HONESTY."""
    import ast, collections
    found = collections.Counter()
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not node.name.startswith('test'):
            continue
        for decorator in node.decorator_list:
            text = ast.unparse(decorator)
            found.update(key for key, words in (('retry', ('flaky', 'rerun', 'retry')), ('timeout', ('timeout',)), ('skip', ('skip', 'xfail'))) if any(w in text for w in words))
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call) and ast.unparse(sub.func) in ('time.sleep', 'sleep', 'asyncio.sleep'):
                found['sleep'] += 1
            elif isinstance(sub, ast.Call) and ast.unparse(sub.func) in ('pytest.skip', 'pytest.xfail', 'self.skipTest'):
                found['skip'] += 1
            elif isinstance(sub, ast.Assert) and isinstance(sub.test, ast.Constant) and sub.test.value:
                found['trivial'] += 1
    return found

def scan_test_baseline():
    import pathlib
    for path in pathlib.Path(WORKSPACE).rglob('*.py'):
        if is_test_file(path) and not {'.git', 'node_modules', '__pycache__'} & set(path.parts):
            try:
                test_baseline[str(path)] = test_shortcuts(path.read_text())
            except (SyntaxError, ValueError, OSError, UnicodeDecodeError):
                pass

# ponytail: the baseline is taken when the kernel starts; after a kernel restart it reflects the edited workspace
TEST_SHORTCUTS = True
test_baseline = {}
import collections, threading
baseline_thread = threading.Thread(target=scan_test_baseline, daemon=True)
if TEST_SHORTCUTS:
    baseline_thread.start()

def undefined_names(source, filename):
    """Module-level names referenced but never bound; None when a star import hides what exists."""
    import builtins, symtable
    if 'import *' in source:
        return None
    top = symtable.symtable(source, filename, 'exec')
    known = set(dir(builtins)) | {'__file__', '__name__', '__doc__', '__spec__', '__path__', '__builtins__', '__loader__', '__package__', '__annotations__', '__cached__', '__class__'}
    defined = known | {s.get_name() for s in top.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
    missing, stack = set(), [top]
    while stack:
        table = stack.pop()
        stack.extend(table.get_children())
        for s in table.get_symbols():
            if s.is_referenced() and (table is top or s.is_global()) and s.get_name() not in defined:
                missing.add(s.get_name())
    return missing

def committed_source(file):
    """The file's text at git HEAD, or None outside a git checkout or for untracked files."""
    import subprocess
    try:
        r = subprocess.run(['git', '-C', str(file.parent), 'show', f'HEAD:./{file.name}'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None

def lint(*paths):
    """Report syntax errors, undefined module-level names and new test shortcuts (sleep, retry, skip) in .py files.
    Names already undefined at git HEAD are pre-existing and not reported; non-.py files are skipped."""
    import pathlib
    base = pathlib.Path(WORKSPACE)
    files = [base / p for p in paths] or [p for p in base.rglob('*.py') if not {'.git', 'node_modules', '__pycache__'} & set(p.parts)]
    skipped = [f for f in files if f.suffix != '.py']
    files = [f for f in files if f.suffix == '.py']
    problems = []
    for file in files:
        try:
            source = file.read_text()
            missing = undefined_names(source, str(file))
        except (SyntaxError, ValueError, OSError, UnicodeDecodeError) as error:
            problems.append(f'{file}: {type(error).__name__}: {error}')
            continue
        if TEST_SHORTCUTS and is_test_file(file):
            baseline_thread.join()
            added = test_shortcuts(source) - test_baseline.get(str(file), collections.Counter())
            problems.extend(f'{file}: +{count} {HONESTY[key]}' for key, count in sorted(added.items()))
        if missing:
            old = committed_source(file)
            try:
                missing -= (undefined_names(old, str(file)) or set()) if old is not None else set()
            except (SyntaxError, ValueError):
                pass
        if missing:
            problems.append(f'{file}: undefined names {sorted(missing)}')
    note = f' (skipped non-Python: {", ".join(f.name for f in skipped)})' if skipped else ''
    return '\n'.join(problems) + note if problems else f'ok: {len(files)} files, no syntax errors, new undefined names or new test shortcuts{note}'

scope.update(sh=sh, patch=patch, lint=lint, Path=__import__('pathlib').Path)
active_output = contextvars.ContextVar('output', default=None)

class Output:
    encoding = 'utf-8'
    def write(self, text):
        cell = active_output.get()
        if cell is not None:
            cell.write(text)
        return len(text)
    def flush(self): pass
    def isatty(self): return False

class CellOutput:
    def __init__(self):
        self.buffer = bytearray()
        self.truncated = False
        self.finished = False
    def write(self, text):
        if self.finished: return
        remaining = 32768 - len(self.buffer)
        chunk = text[:remaining].encode('utf-8', 'replace')
        self.buffer.extend(chunk[:remaining])
        self.truncated |= len(chunk) > remaining or len(text) > remaining

sys.stdout = sys.stderr = Output()

def compile_cell(source):
    tree = ast.parse(source, '<cell>', 'exec')
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = tree.body[-1]
        tree.body[-1] = ast.copy_location(ast.Assign([ast.Name('__ms_result__', ast.Store())], last.value), last)
        ast.fix_missing_locations(tree)
    return compile(tree, '<cell>', 'exec', ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)

async def serve():
    while line := await asyncio.to_thread(request_stream.readline):
        request = json.loads(line)
        out = CellOutput()
        token = active_output.set(out)
        ok = True
        try:
            scope.pop('__ms_result__', None)
            result = eval(compile_cell(request['code']), scope)
            if result is not None: await result
            value = scope.pop('__ms_result__', None)
            if value is not None: print(repr(value))
        except BaseException:
            ok = False
            traceback.print_exc(limit=5)
        finally:
            out.finished = True
            active_output.reset(token)
        print(json.dumps({'id': request['id'], 'ok': ok, 'truncated': out.truncated,
                          'output': out.buffer.decode('utf-8', 'replace')}), file=reply, flush=True)

asyncio.run(serve())
`;

/** Compact repo map for the first prompt: text files with line counts per directory, Python directories first, overflow collapsed to counts. */
export function repoMap(workspace: string, budget = 4000): string {
  const skip = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.venv']);
  const dirs: { rel: string; files: string[]; py: boolean }[] = [];
  const walk = (rel: string) => {
    const entries = fs.readdirSync(path.join(workspace, rel), { withFileTypes: true }).filter((e) => !skip.has(e.name) && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const files: string[] = [];
    for (const e of entries.filter((e) => e.isFile())) {
      const buf = fs.readFileSync(path.join(workspace, rel, e.name));
      if (buf.includes(0)) continue;
      files.push(`${e.name} ${buf.toString('latin1').split('\n').length - 1}`);
    }
    if (files.length) dirs.push({ rel, files, py: files.some((f) => f.includes('.py ')) });
    for (const e of entries.filter((e) => e.isDirectory())) walk(path.join(rel, e.name));
  };
  walk('.');
  const depth = (rel: string) => rel.split('/').length;
  dirs.sort((a, b) => Number(b.py) - Number(a.py) || depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const { rel, files } of dirs) {
    const full = `${rel}/: ${files.join(', ')}`;
    const line = used + full.length <= budget ? full : `${rel}/: ${files.length} files`;
    if (used + line.length > budget) { omitted++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).stdout.trim();
  return [
    `Repo map (text files with line counts; ${python}):`,
    ...lines,
    ...(omitted ? [`... ${omitted} more directories`] : []),
  ].join('\n');
}

/** Kernel interpreter for host mode: the environment's python3 (so packages installed there import in cells) when it is >= 3.9 (`ast.unparse`), else the fallback. */
export function hostPython(fallback: string): string {
  const probe = spawnSync('python3', ['-c', 'import sys\nif sys.version_info >= (3, 9): print(sys.executable)'], { encoding: 'utf8', timeout: 10_000 });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : fallback;
}

/** Batching workflow appended to the system prompt (`MS_REPL_BATCH_PROMPT=1` in the A/B runner; always on in Terminal-Bench). */
export const PYTHON_REPL_WORKFLOW = '\n\n# Code-Mode Workflow (`python_repl` tool)\n- Aim for two cells, then answer. Cell 1 explores: list files, grep for every symbol the task names, print every relevant source and test file in full (for files over ~300 lines, print imports, `grep -n` of definitions, and only the regions you need), and run the tests or repro, all together. Cell 2 fixes and verifies: apply every edit in one `patch({...})` call (new files via `Path.write_text`), then run `lint(...)` on every edited file and the full checks in the same cell. Test suites can have pre-existing failures, so `lint` is the reliable signal for broken imports. If the checks pass, answer immediately without rerunning them. Use another cell only when its result decides what to do next.\n- One cell can print up to 32 KiB, so read several whole files at once instead of excerpts across cells. Use the preloaded `sh`, `patch`, `lint` and `Path` instead of writing your own helpers.\n- Print only short check results after edits; keep large intermediate values in Python variables.';

export function buildPythonReplPrompt(base: string): string {
  return base.replace('with bash and file tools.', 'with one persistent Python REPL.')
    .replace('with the "edit" or "write_file" tool', 'via the Python REPL');
}

export function createPythonRepl(workspace: string, stateDir: string, { timeoutMs = 30_000, testShortcuts = true, host }: { timeoutMs?: number; testShortcuts?: boolean; host?: { python: string } } = {}) {
  // host: run the kernel unsandboxed with this interpreter, for callers already inside a container (Terminal-Bench).
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) throw new Error('invalid Python cell timeout');
  const root = fs.realpathSync(workspace);
  const home = fs.realpathSync(os.homedir());
  if (root === home || home.startsWith(root + path.sep) || ['/', '/usr', '/bin', '/lib', '/lib64'].some((dir) => root === dir || (dir !== '/' && root.startsWith(dir + path.sep)))) {
    throw new Error('Python REPL requires a separate workspace');
  }
  const description = `Run Python in ${host ? root : '/workspace'}. Variables, imports and functions persist across cells. Top-level await works; save asyncio tasks in variables and await them later. The last expression is displayed. Use pathlib and subprocess.run(..., capture_output=True, text=True) for local work. Preloaded: sh(cmd) returns "[exit N]" plus stdout/stderr; patch({path: [(old, new), ...]}) applies exact replacements (each old must match once, or pass (old, new, count)) across files all-or-nothing and reports every mismatch with the closest line; ${testShortcuts ? 'lint(*paths) reports syntax errors, undefined names and test shortcuts added since start (sleep, retry, skip, raised timeouts; run it on every file you edited)' : 'lint(*paths) reports syntax errors and undefined names (run it on every file you edited)'}; Path is pathlib.Path. Output over 32 KiB is truncated.${host ? '' : ' No network.'}`;
  const parameters = { type: 'object', properties: { code: { type: 'string', description: 'Python cell source' } }, required: ['code'] };
  let child: ReturnType<typeof launch> | undefined;
  let pending: { id: number; finish: (value: string) => void } | undefined;
  let closed = false;
  let previousFailure: string | undefined;
  let seq = 0;
  let queue = Promise.resolve('');

  function launch() {
    const source = testShortcuts ? worker : worker.replace('TEST_SHORTCUTS = True', 'TEST_SHORTCUTS = False');
    const proc = host
      ? spawn(host.python, ['-u', '-c', source], { cwd: root, env: { ...process.env, REPL_WORKSPACE: root }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('/usr/bin/bwrap', pythonSandbox(root, stateDir, ['-c', source]), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let frame = '';
    let stopping: string | undefined;
    const fail = (reason: string) => {
      stopping ??= reason;
      proc.kill('SIGKILL');
    };
    const exit = new Promise<void>((resolve) => proc.once('close', (code, signal) => {
      const reason = stopping ?? `Python kernel exited (${signal ?? code ?? 'unknown status'})`;
      const report = `${reason}${stderr.trim() ? `\n${stderr.trim()}` : ''}`;
      child = undefined;
      if (!closed) previousFailure = report;
      pending?.finish(`Error: ${report}\nIn-memory state was lost. Workspace changes were not rolled back.`);
      resolve();
    }));
    proc.on('error', (error) => fail(`Cannot launch Python sandbox: ${error.message}`));
    proc.stdin.on('error', () => fail('Python kernel input closed'));
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stopping) return;
      frame += chunk;
      let newline: number;
      while ((newline = frame.indexOf('\n')) !== -1) {
        if (newline > 262144) return fail('Python reply exceeded the protocol limit; kernel stopped.');
        const line = frame.slice(0, newline);
        frame = frame.slice(newline + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (!pending || !reply || reply.id !== pending.id || typeof reply.output !== 'string' || typeof reply.ok !== 'boolean') continue;
        const note = reply.truncated ? '\n[output truncated; keep large values in Python and print a slice]' : '';
        const restart = previousFailure ? `[Python kernel restarted; in-memory state was lost. Workspace changes were not rolled back. Previous failure: ${previousFailure}]\n` : '';
        previousFailure = undefined;
        pending.finish(`${reply.ok ? '' : 'Error: '}${restart}${reply.output || '(no output)'}${note}`);
      }
      if (frame.length > 262144) fail('Python reply exceeded the protocol limit; kernel stopped.');
    });
    return { proc, exit, fail };
  }

  return {
    name: 'python_repl', description, parameters, isReadOnly: false,
    toDefinition: () => ({ name: 'python_repl', description, parameters }),
    execute(args: Record<string, unknown>): Promise<string> {
      const code = args.code;
      if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 32768) return Promise.resolve('Error: expected non-empty Python code up to 32768 bytes');
      queue = queue.then(() => new Promise<string>((resolve) => {
        if (closed) { resolve('Error: Python REPL is closed'); return; }
        child ??= launch();
        const id = ++seq;
        const kernel = child;
        const timer = setTimeout(() => kernel.fail('Python cell timed out; kernel stopped. Cell was not replayed.'), timeoutMs);
        pending = { id, finish: (value) => { clearTimeout(timer); pending = undefined; resolve(value); } };
        kernel.proc.stdin.write(`${JSON.stringify({ id, code })}\n`);
      }));
      return queue;
    },
    async close() {
      closed = true;
      if (!child) return;
      child.fail('Python REPL closed');
      await child.exit;
    },
  };
}
