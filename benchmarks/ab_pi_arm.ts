/**
 * Third arm for the uc01 A/B: the Pi harness itself (`pi -p -ne`), scored by the same oracle.
 *
 *   bun benchmarks/ab_pi_arm.ts --trials 1
 *   bun benchmarks/ab_pi_arm.ts --trials 3 --model claude-bridge/claude-haiku-5-5 --thinking medium
 *
 * Writes `runs-pi.jsonl` (arm `C_pi`) in the same record shape as `ab_single_tool.ts`, so
 * `benchmarks/paired_bootstrap.py --arms A_eight,C_pi` can pair them. Self-contained on purpose:
 * `ab_single_tool.ts` runs `main()` on import and is edited concurrently.
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { assessPytestCoverage, runPytest, type PytestReport } from './pytest_oracle.js';

const PI = process.env.PI_BIN ?? 'pi';
const FIXTURE = '/home/hoang/nhom-30/axiom-cli/evals/fixtures/uc01';
const TASK_DIR = '/home/hoang/nhom-30/axiom-cli/evals/uc01';
const GUARD = ['tests'];

const CASES: Record<string, { probe: { code: string; expect: string } }> = {
  'uc01-01-bug-crash-null': {
    probe: { code: "from tinydb_demo.format import format_tags\nprint(repr(format_tags({'title': 'x'})))", expect: "''" },
  },
  'uc01-02-bug-test-fail': {
    probe: {
      code: "import tempfile\nfrom tinydb_demo.store import Store\ns = Store(tempfile.mkdtemp() + '/db.json')\ns.add({'title': 'Hello World'})\nprint(len(s.search('hello')))",
      expect: '1',
    },
  },
  'uc01-03-bug-reproducible': {
    probe: { code: 'from tinydb_demo.pretty import render_table\nprint(repr(render_table([])))', expect: "''" },
  },
};

function taskFor(caseId: string): string {
  return [
    'Fix the following bug in the workspace. Reproduce or verify it, apply the minimal fix, and run tests/checks to confirm.',
    '',
    fs.readFileSync(path.join(TASK_DIR, `${caseId}.json`), 'utf8'),
  ].join('\n');
}

function runProbe(workspace: string, probe: { code: string; expect: string }) {
  const res = spawnSync('python3', ['-c', probe.code], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0 && output === probe.expect, output: output.slice(0, 400) };
}

function snapshotFiles(target: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(target)) return files;
  const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__') walk(full);
      } else if (!entry.name.endsWith('.pyc')) {
        files.set(path.relative(target, full), digest(full));
      }
    }
  };
  if (fs.statSync(target).isFile()) files.set(path.basename(target), digest(target));
  else walk(target);
  return files;
}

function guardSnapshot(workspace: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of GUARD) {
    for (const [file, hash] of snapshotFiles(path.join(workspace, entry))) files.set(`${entry}/${file}`, hash);
  }
  return files;
}

function tamperedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, hash] of before) if (after.get(file) !== hash) out.push(file);
  return out;
}

interface PiStats {
  turns: number;
  toolCalls: number;
  toolOutputBytes: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  agentStatus: string;
  stderrTail: string;
}

/** Reads `pi --mode json` JSONL: turn_end = a turn, tool_execution_start = a tool call. */
function parsePiEvents(stdout: string, stderr: string): PiStats {
  const stats: PiStats = {
    turns: 0, toolCalls: 0, toolOutputBytes: 0, promptTokens: 0,
    completionTokens: 0, cacheReadTokens: 0, costUsd: 0, agentStatus: 'ok',
    stderrTail: stderr.slice(-600),
  };
  let settled = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn_end') stats.turns++;
    else if (event.type === 'tool_execution_start') stats.toolCalls++;
    else if (event.type === 'tool_execution_end') {
      for (const block of event.result?.content ?? []) {
        if (typeof block?.text === 'string') stats.toolOutputBytes += Buffer.byteLength(block.text, 'utf8');
      }
    } else if (event.type === 'agent_settled') settled = true;
    else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const usage = event.message.usage;
      if (usage) {
        stats.promptTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        stats.completionTokens += usage.output ?? 0;
        stats.cacheReadTokens += usage.cacheRead ?? 0;
        stats.costUsd += usage.cost?.total ?? 0;
      }
      if (event.message.stopReason === 'error') stats.agentStatus = 'error';
    }
  }
  if (!settled && stats.agentStatus === 'ok') stats.agentStatus = 'incomplete';
  return stats;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    trials: 1,
    cases: Object.keys(CASES),
    model: 'claude-bridge/claude-haiku-5-5',
    thinking: 'medium',
    maxTurns: 40,
    lean: false,
    outDir: `/home/hoang/ms/benchmarks/artifacts/pi-arm-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${argv[i - 1]}`);
      return value;
    };
    const arg = argv[i]!;
    if (arg === '--trials') opts.trials = Number(next());
    else if (arg === '--cases') opts.cases = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--model') opts.model = next();
    else if (arg === '--thinking') opts.thinking = next();
    else if (arg === '--max-turns') opts.maxTurns = Number(next());
    // `-ns -np -nc`: no skills, no prompt templates, no AGENTS.md. Measured: 16,654 -> 1,723 prompt tokens on a trivial task.
    else if (arg === '--lean') opts.lean = true;
    else if (arg === '--out') opts.outDir = path.resolve(next());
    else throw new Error(`unknown argument: ${arg}`);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const runsPath = path.join(opts.outDir, 'runs-pi.jsonl');
  const baseline: PytestReport = runPytest(FIXTURE);
  console.log(
    `baseline: ${baseline.passed.length} passed, ${baseline.failed.length} failed [${baseline.failed.join(', ') || 'none'}]`,
  );
  console.log(`pi arm · model ${opts.model} · thinking ${opts.thinking} · trials ${opts.trials} · cases ${opts.cases.length} · flags -ne${opts.lean ? ' -ns -np -nc' : ''}\n`);

  for (let trial = 0; trial < opts.trials; trial++) {
    for (const caseId of opts.cases) {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ab-pi-${caseId}-`));
      const workspace = path.join(tmpRoot, 'workspace');
      fs.cpSync(FIXTURE, workspace, { recursive: true });
      const guardBefore = guardSnapshot(workspace);
      const started = performance.now();
      // The parent session's provider/model env would hijack a fresh pi process.
      const childEnv = { ...process.env };
      for (const key of ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_SESSION_FILE', 'PI_SESSION_ID']) delete childEnv[key];
      const result = spawnSync(
        PI,
        ['-p', '-ne', ...(opts.lean ? ['-ns', '-np', '-nc'] : []), '--no-session', '--mode', 'json', '--model', opts.model, '--thinking', opts.thinking, '--', taskFor(caseId)],
        { cwd: workspace, encoding: 'utf8', timeout: 900_000, maxBuffer: 256 * 1024 * 1024, env: childEnv },
      );
      const wallClockMs = performance.now() - started;
      const stats = parsePiEvents(result.stdout ?? '', result.stderr ?? '');
      const guardAfter = guardSnapshot(workspace);
      const tampered = tamperedFiles(guardBefore, guardAfter);
      const post = runPytest(workspace);
      const coverage = assessPytestCoverage(baseline, post);
      const probe = runProbe(workspace, CASES[caseId]!.probe);
      const record = {
        arm: 'C_pi',
        caseId,
        trial,
        agentStatus: result.status === 0 ? stats.agentStatus : `exit_${result.status}`,
        targetFixed: probe.ok,
        probeOutput: probe.output,
        noRegressions: coverage.noRegressions,
        verificationComplete: coverage.verificationComplete,
        newFailures: coverage.newFailures,
        collectionError: post.collectionError,
        testsIntact: tampered.length === 0,
        tamperedTestFiles: tampered,
        overallPassed: probe.ok && coverage.noRegressions && coverage.verificationComplete && tampered.length === 0,
        llmTurns: stats.turns,
        toolCalls: stats.toolCalls,
        toolOutputBytes: stats.toolOutputBytes,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        cachedTokens: stats.cacheReadTokens,
        totalTokens: stats.promptTokens + stats.completionTokens,
        costDollars: stats.costUsd || null,
        wallClockMs: Math.round(wallClockMs),
        stderrTail: stats.stderrTail,
        piFlags: `-ne${opts.lean ? ' -ns -np -nc' : ''}`,
      };
      fs.appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
      console.log(
        `${record.overallPassed ? 'PASS' : 'FAIL'} C_pi ${caseId} t${trial} · turns=${record.llmTurns} tools=${record.toolCalls} ` +
          `tok=${record.promptTokens}+${record.completionTokens} ${(record.wallClockMs / 1000).toFixed(1)}s ` +
          `${record.overallPassed ? '' : `[${record.agentStatus}] ${record.stderrTail.replace(/\s+/g, ' ').slice(0, 200)}`}`,
      );
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  const records = fs.readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const mine = records.filter((r: any) => r.arm === 'C_pi');
  console.log(
    `\nC_pi: ${mine.filter((r: any) => r.overallPassed).length}/${mine.length} passed · median turns ${median(mine.map((r: any) => r.llmTurns))} ` +
      `· median tools ${median(mine.map((r: any) => r.toolCalls))} · median wall ${median(mine.map((r: any) => r.wallClockMs))}ms\nartifacts: ${runsPath}`,
  );
}

main();
