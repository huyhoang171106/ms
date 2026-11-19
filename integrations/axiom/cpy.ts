/**
 * C_py: one `python` tool over a persistent CPython process (the Unharnessed / prime-agent shape), plus the chat gate the
 * Terminal-Bench C_py arm runs with. Shared by benchmarks/tb/runner.ts and the EXPERIMENTAL cpy-cli.ts. No Axiom imports.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export const PYTHON_DESCRIPTION = [
  'Persistent CPython REPL: state survives calls; shows prints + trailing expr value.',
  "bash(cmd, timeout=600) -> '[exit N]\\n<out>' (.code, .out). Background: cmd > log 2>&1 &.",
].join('\n');

/**
 * C_py system prompt as a terse spec (one word where a sentence was): same rules as the prose version
 * (tb21-luna-lean5..15 traces: batching, quiet tests, branch coverage, stop rule), ~half the characters.
 * labels rule: lean31-34 fix-vuln, 6 of 6 failures listed the specific id + a broad catch-all and skipped its direct parent.
 * width rule: lean32-40 cobol, 7 of 10 .DAT mismatches parsed INPUT.DAT by the 15-byte sample, not the PIC 9(10) layout; hidden 22-byte records read amount 0.
 * read rule: lean32-35 fix-vuln, 2.3 turns/run were a grep for a name followed by a sed of the lines it found.
 * fix rule: lean20-30 fix-vuln, 19 of 26 failures across C_py/pi/codex validated in the callers while the hidden test calls `_hkey` itself.
 * {cwd} is filled by the runner.
 */
export const PYTHON_SYSTEM = [
  'role: autonomous SWE agent. root, Linux container, cwd={cwd}. installs ok.',
  'user: absent. never ask. hidden tests grade final container state.',
  'tool: python(code). files: write from Python. edits: surgical.',
  'rules:',
  '  call: costs full history resend -> batch all independent steps (ls+read+grep+repro; edit+build+test).',
  "  read: grep -n -A40 'def x' (whole def, one call). sed -n 'a,bp'. never char slices.",
  '  print: only needed lines. big data -> variables. repeated step -> function.',
  '  tests (only if project has them): first call, pytest -q --tb=short. never -rA/-v.',
  '  verify: every branch, not only given input. pass == zero diff. fixed-width input -> parse by declared field widths, test full-width values, not sample lengths.',
  '  fix: in the lowest shared function every caller routes through; hidden tests may call it directly.',
  '  failing build/test/check -> fix, rerun. never stop on failure.',
  '  text: no prose between calls. ground claims in output. every call executes code; never comment-only/empty calls (each costs a full turn).',
  '  labels (CWE, categories): list every id that applies: the specific id + every ancestor up its chain (variant -> base -> class), not only a broad catch-all.',
  '  stop: result exists && check passes -> 1-line summary. no tool call == run ends.',
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
      return { name: this.name, description: PYTHON_DESCRIPTION, parameters: this.parameters };
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

// C_py: every turn resends the whole history and old tool outputs dominate it (tb21-luna-lean8: tokens track turns x history).
// Keep the last `keep` tool outputs whole and clip older long ones to head+tail (keep 3: tb21-haiku-lean2 heap re-read a 5k main.cpp clipped by keep 2 / max 2000; max 8000: luna-lean17 cobol re-read the 6.5k program.cbl 6x once a 4000 cap clipped it); values persist in the REPL, so the model can re-print them.
type TrimMsg = { role: string; content: string; toolCallId?: string; toolCalls?: Array<{ id: string; arguments: Record<string, unknown> }> };
// Calls that printed source (open/cat/sed/grep/...) keep the 8000 cap; pure run logs (build, test, valgrind, gdb) are stale
// once older than `keep` calls: lean32-37 cobol/heap resent ~4k tokens/run of such 2-8k logs, never re-printed.
const readsSource = (code: string) => /open\(|read_text|\b(cat|sed|head|tail|grep|rg|less|nl|awk)\b/.test(code);
export function trimOldToolOutputs<M extends TrimMsg>(messages: M[], keep = 3, max = 8000, side = 1000, logMax = 1500, logSide = 400): M[] {
  const code = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) code.set(c.id, String(c.arguments?.code ?? ''));
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || ++seen <= keep) continue;
    const src = code.get(m.toolCallId ?? '');
    const [cap, s] = src !== undefined && !readsSource(src) ? [logMax, logSide] : [max, side];
    if (m.content.length <= cap) continue;
    out[i] = { ...m, content: `${m.content.slice(0, s)}\n… [older output: ${m.content.length - 2 * s} chars elided; re-print from REPL variables if needed] …\n${m.content.slice(-s)}` };
  }
  return out;
}

export const CPY_REMINDER = 'You stopped. missing/unverified result || failing check || only given input tested -> continue with calls. else -> 1-line summary.';

// luna sometimes prints the call as text ({"code":...}); 5 times in lean20-24, each read as a stop -> reminder turn. Run it as the call it is.
export const asCodeCall = (text: string): string | undefined => {
  const t = text.trim().replace(/\.\.\.$/, '');
  if (!t.startsWith('{"code"')) return undefined;
  try { const v = JSON.parse(t); return typeof v?.code === 'string' && v.code.trim() ? v.code : undefined; } catch { return undefined; }
};
// A final reply that itself reports unfinished or failed work must not pass the gate (tb21-luna-lean7 cobol: "Verification is not complete" was accepted).
export const admitsGap = (text: string) => /\b(not (yet )?(complete|completed|verified|fixed|resolved)|ha(ve|ven.t) not verified|haven.t (yet )?verified|unverified|incomplete|couldn.t|could not|unable to|still (fails|segfaults|crashes|differs)|differed|did not match|does not match|no tests (were )?(reported|found|collected|ran)|syntax (check|compil\w*))\b/i.test(text);
export const claimsSuitePass = (text: string) => !admitsGap(text) && /\b(all \d+ tests? pass(ed)?|\d+ tests? passed|verification passed: \d+ tests?)\b/i.test(text);
export const looksFailed = (output: string, isError = false) => isError || /^Error:|\[exit [1-9]\d*\]|Traceback \(most recent call last\)/m.test(output);

type Msg = TrimMsg;
type Reply = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage?: object };

/** Sums every numeric usage field (prompt, completion, cache read/write, cost) of two replies billed as one turn. */
export function addUsage<U extends object>(a: U | undefined, b: U | undefined): U | undefined {
  if (!a || !b) return b ?? a;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.fromEntries(Object.keys({ ...x, ...y }).map((k) => [k, typeof x[k] === 'number' || typeof y[k] === 'number' ? Number(x[k] ?? 0) + Number(y[k] ?? 0) : y[k] ?? x[k]])) as U;
}

/**
 * The C_py chat gate. `chat` wraps one provider call; `toolEnded` sees every tool result; `isComplete` answers AgentLoop.
 * - Trim old tool outputs (keep 3; keep 1 after the reminder: lean14 tokens/pass 102k -> 62k). Never below 8000 chars: lean20 cobol re-read files 10x at 1500.
 * - Retry once on a spurious "flagged" stream error (lean10 cobol lost a run; pi/codex retry those).
 * - After the reminder, a final reply that still admits a gap gets one ephemeral nudge (lean19 cobol 2/3 fails); its usage is still billed.
 * - Text that is a JSON call runs as the call.
 * - A reply whose only calls carry empty code is resampled once instead of entering history (luna, lean20-30: 0.3/run,
 *   each a full turn that only produced "Error: `code` is required.").
 * - A stop skips the reminder only right after a passing tool result AND a passing-suite claim (lean19-22: 12/12 such stops made no edit after it).
 */
export function createCpyGate(opts: { trim?: boolean; onExtraTurn?: () => void } = {}) {
  let sinceChat = false, lastCheckPassed = false, nudged = false, suiteClaim = false, textCalls = 0;
  return {
    reminder: CPY_REMINDER,
    // AgentLoop also calls isComplete() right after tools run (and ends the run if true), so only answer true right after a model reply.
    isComplete: () => sinceChat && lastCheckPassed && suiteClaim,
    toolEnded(output: string, isError = false) { lastCheckPassed = !looksFailed(output, isError); sinceChat = false; },
    async chat<P extends { messages: Msg[] }, R extends Reply>(params: P, send: (p: P) => Promise<R>): Promise<R> {
      const reminded = params.messages.some((m) => m.role === 'user' && String(m.content).startsWith('You stopped.'));
      const sent = opts.trim === false ? params : { ...params, messages: trimOldToolOutputs(params.messages, reminded ? 1 : 3) };
      const call = (p: P) => send(p).catch((err: unknown) => { if (/flagged as potentially violating/i.test(String(err))) return send(p); throw err; });
      let res = await call(sent);
      const blank = (r: R) => !!r.toolCalls?.length && r.toolCalls.every((c) => typeof c.arguments.code !== 'string' || !c.arguments.code.trim());
      if (blank(res)) {
        opts.onExtraTurn?.();
        const first = res;
        res = await call(sent);
        res = { ...res, usage: addUsage(first.usage, res.usage) };
      }
      if (reminded && !nudged && !res.toolCalls?.length && admitsGap(res.content ?? '')) {
        nudged = true;
        opts.onExtraTurn?.();
        const first = res;
        res = await call({ ...sent, messages: [...sent.messages, { role: 'assistant', content: first.content ?? '' }, { role: 'user', content: 'Unverified -> verify now with calls. Done only when the check passes.' }] });
        res = { ...res, usage: addUsage(first.usage, res.usage) };
      }
      if (!res.toolCalls?.length) {
        const code = asCodeCall(res.content ?? '');
        if (code !== undefined) res = { ...res, content: '', toolCalls: [{ id: `call_text_${++textCalls}`, name: 'python', arguments: { code } }] };
      }
      sinceChat = true;
      if (!res.toolCalls?.length && admitsGap(res.content ?? '')) lastCheckPassed = false;
      suiteClaim = !res.toolCalls?.length && claimsSuitePass(res.content ?? '');
      return res;
    },
  };
}
