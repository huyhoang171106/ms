/** C_py arm: one `python` tool over a persistent CPython process (the Unharnessed / prime-agent shape). */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export const PYTHON_DESCRIPTION = [
  'Run Python in a persistent CPython REPL; variables and imports survive across calls. The value of a trailing expression is shown, plus anything printed.',
  "Shell: bash(cmd, timeout=600) -> result printing as '[exit N]\\n<output>' (also .code, .out). Files: open()/pathlib. Background processes must redirect output (cmd > log 2>&1 &). Example: print(bash('ls -la')); print(open('main.c').read()[:2000])",
].join('\n');

export function createPythonTool(opts: { python: string; kernel: string; cwd: string; timeoutMs: number }) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let lines: AsyncIterator<string> | undefined;
  const start = () => {
    child = spawn(opts.python, ['-u', opts.kernel], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stderr.resume();
    lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  };
  const kill = () => {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    child = undefined;
  };
  return {
    name: 'python',
    description: PYTHON_DESCRIPTION,
    parameters: { type: 'object' as const, properties: { code: { type: 'string', description: 'Python source to run' } }, required: ['code'] },
    isReadOnly: false,
    toDefinition() {
      return { name: 'python', description: PYTHON_DESCRIPTION, parameters: this.parameters };
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const code = typeof args.code === 'string' ? args.code : '';
      if (!code.trim()) return 'Error: `code` is required.';
      if (!child) start();
      child!.stdin.write(`${JSON.stringify({ code })}\n`);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), opts.timeoutMs); });
      const next = await Promise.race([lines!.next(), timeout]).finally(() => clearTimeout(timer));
      if (next === 'timeout' || next.done) {
        kill();
        return next === 'timeout'
          ? `Error: cell exceeded ${opts.timeoutMs / 1000}s; the REPL was restarted and its state is lost.`
          : 'Error: the REPL process exited; its state is lost.';
      }
      return String(JSON.parse(next.value).output);
    },
    async close() { kill(); },
  };
}
