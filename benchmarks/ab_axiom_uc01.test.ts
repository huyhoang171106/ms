import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planSandbox } from '../../nhom-30/src/tools/sandbox.js';
import { BUNDLED_SKILLS_DIR } from '../../nhom-30/src/tools/bundled-skills.js';
import { registerSecret } from '../../nhom-30/src/core/secrets.js';
import { destructiveReason } from '../../nhom-30/src/tools/bash.js';
import {
  aggregateNormalizedUsage,
  calculateNormalizedCost,
  normalizeProviderUsage,
  resolveModelPricing,
  UnknownModelPricingError,
} from './ab_axiom_accounting.js';
import {
  appendRunRecord,
  buildExperimentSchedule,
  computeWorkspaceDiff,
  loadRunRecords,
  redactConfigObject,
} from './ab_axiom_artifacts.js';
import { captureBaselinePytest, verifyWorkspace } from './ab_axiom_oracle.js';
import {
  buildControlledPytestInvocation,
  buildToolTraceEntry,
  getExecutionPolicySnapshot,
  registerBaselineTools,
  registerMsTools,
  resolveAllowlistedBundledSkill,
  RevisionAliasRegistry,
  validatePytestTarget,
} from './ab_axiom_tools.js';
import {
  attachFailureSnippetsViaRpc,
  distillCommandOutput,
  gcLogDir,
  MsAxiomAdapter,
} from '../examples/axiom_adapter.js';
import { ToolRegistry } from '../../nhom-30/src/tools/registry.js';
import {
  buildInfraErrorRecord,
  NormalizedCostTracker,
  parseCliArgs,
  runExperiment,
  type RunRecord,
} from './ab_axiom_uc01.js';

const FIXTURE_DIR = '/home/hoang/nhom-30/evals/fixtures/uc01';
const CASES_DIR = '/home/hoang/nhom-30/evals/uc01';
const tempDirs: string[] = [];

function makeTempFixtureCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-test-ws-'));
  tempDirs.push(dir);
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

function makeTempDir(prefix = 'ab-test-art-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('F1: Normalized Usage & Explicit Pricing', () => {
  test('resolves claude-haiku-5-5 and anthropic/claude-haiku-5-5 to canonical claude-haiku-5.5', () => {
    const p1 = resolveModelPricing('claude-haiku-5-5');
    const p2 = resolveModelPricing('anthropic/claude-haiku-5-5');
    expect(p1.canonicalId).toBe('claude-haiku-5.5');
    expect(p2.canonicalId).toBe('claude-haiku-5.5');
    expect(p1.inputPer1M).toBe(0.10);
    expect(p1.cacheReadPer1M).toBe(0.02);
    expect(p1.cacheWrite5mPer1M).toBe(0.125);
    expect(p1.outputPer1M).toBe(0.50);
  });

  test('unknown model throws UnknownModelPricingError instead of silent fallback', () => {
    expect(() => resolveModelPricing('anthropic/nonexistent-model-xyz')).toThrow(UnknownModelPricingError);
  });

  test('supports unpriced models (trollllm/deepseek-v4-1-flash and allowUnpriced) with null USD and exact tokens', () => {
    const p = resolveModelPricing('trollllm/deepseek-v4-1-flash');
    expect(p.canonicalId).toBe('deepseek-v4-1-flash');
    expect(p.pricingStatus).toBe('unpriced');
    expect(p.inputPer1M).toBeNull();
    expect(p.outputPer1M).toBeNull();

    const pFallback = resolveModelPricing('custom/unpriced-model', { allowUnpriced: true });
    expect(pFallback.pricingStatus).toBe('unpriced');
    expect(pFallback.inputPer1M).toBeNull();

    const usage = normalizeProviderUsage({
      promptTokens: 500,
      completionTokens: 120,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 0,
    });
    const calc = calculateNormalizedCost('trollllm/deepseek-v4-1-flash', usage);
    expect(calc.costKind).toBe('unpriced');
    expect(calc.costDollars).toBeNull();
    expect(calc.breakdown.uncachedInputUsd).toBeNull();
    expect(calc.breakdown.outputUsd).toBeNull();

    const agg = aggregateNormalizedUsage([usage], 'trollllm/deepseek-v4-1-flash');
    expect(agg.totals.uncachedInput).toBe(500);
    expect(agg.totals.cacheRead).toBe(2000);
    expect(agg.totals.output).toBe(120);
    expect(agg.cost.costKind).toBe('unpriced');
    expect(agg.cost.costDollars).toBeNull();
  });

  test('does not double-subtract cache from promptTokens and reflects cacheRead & cacheWrite deltas', () => {
    const lowCache = normalizeProviderUsage({
      promptTokens: 100,
      completionTokens: 10,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0,
    });
    const highCache = normalizeProviderUsage({
      promptTokens: 100,
      completionTokens: 10,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 0,
    });
    const withCacheWrite = normalizeProviderUsage({
      promptTokens: 100,
      completionTokens: 10,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 50_000,
    });

    // No subtraction: uncachedInput stays 100 even when cacheRead is 100,000
    expect(highCache.uncachedInput).toBe(100);
    expect(highCache.cacheRead).toBe(100_000);
    expect(highCache.totalInputAll).toBe(100_100);

    const cLow = calculateNormalizedCost('claude-haiku-5-5', lowCache);
    const cHigh = calculateNormalizedCost('claude-haiku-5-5', highCache);
    const cWrite = calculateNormalizedCost('claude-haiku-5-5', withCacheWrite);

    expect(cLow.costKind).toBe('estimated');
    expect(cHigh.costDollars).toBeGreaterThan(cLow.costDollars);
    expect(cWrite.costDollars).toBeGreaterThan(cLow.costDollars);

    const agg = aggregateNormalizedUsage([lowCache, highCache], 'anthropic/claude-haiku-5-5');
    expect(agg.totals.uncachedInput).toBe(200);
    expect(agg.totals.cacheRead).toBe(101_000);
    expect(agg.totals.output).toBe(20);

    const tracker = new NormalizedCostTracker();
    tracker.record('claude-haiku-5-5', {
      promptTokens: 100,
      completionTokens: 10,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      totalTokens: 110,
    });
    expect(tracker.getSessionSummary().totalCost).toBe(cHigh.costDollars);
  });
});

describe('F2: External Invariant Oracle', () => {
  const baseline = captureBaselinePytest(FIXTURE_DIR);

  test('rejects all 3 unpatched fixtures', () => {
    for (const caseId of ['uc01-01-bug-crash-null', 'uc01-02-bug-test-fail', 'uc01-03-bug-reproducible']) {
      const ws = makeTempFixtureCopy();
      const res = verifyWorkspace(caseId, ws, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
      expect(res.targetFixed).toBe(false);
      expect(res.overallPassed).toBe(false);
    }
  });

  test('accepts valid minimal patches for all 3 cases', () => {
    // Case 01
    const ws1 = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws1, 'tinydb_demo/format.py'),
      "def format_tags(note):\n    return ', '.join(sorted(note.get('tags') or []))\n",
    );
    const r1 = verifyWorkspace('uc01-01-bug-crash-null', ws1, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(r1.targetFixed).toBe(true);
    expect(r1.noRegressions).toBe(true);
    expect(r1.verificationComplete).toBe(true);
    expect(r1.overallPassed).toBe(true);

    // Case 02
    const ws2 = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws2, 'tinydb_demo/store.py'),
      fs
        .readFileSync(path.join(ws2, 'tinydb_demo/store.py'), 'utf8')
        .replace("query in note['title']", "query.lower() in note['title'].lower()"),
    );
    const r2 = verifyWorkspace('uc01-02-bug-test-fail', ws2, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(r2.targetFixed).toBe(true);
    expect(r2.noRegressions).toBe(true);
    expect(r2.overallPassed).toBe(true);

    // Case 03
    const ws3 = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws3, 'tinydb_demo/pretty.py'),
      "def render_table(rows):\n    if not rows:\n        return ''\n    headers = list(rows[0])\n    widths = [len(header) for header in headers]\n    return '  '.join(_pad_header(header, width) for header, width in zip(headers, widths))\n\n\ndef _pad_header(header, width):\n    return header.ljust(width)\n",
    );
    const r3 = verifyWorkspace('uc01-03-bug-reproducible', ws3, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(r3.targetFixed).toBe(true);
    expect(r3.noRegressions).toBe(true);
    expect(r3.overallPassed).toBe(true);
  });

  test('F2 counterexample 1: Store.search = None fails healthy invariants even if format_tags is fixed', () => {
    const ws = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws, 'tinydb_demo/format.py'),
      "def format_tags(note):\n    return ', '.join(sorted(note.get('tags') or []))\n",
    );
    fs.appendFileSync(path.join(ws, 'tinydb_demo/store.py'), '\nStore.search = None\n');
    const res = verifyWorkspace('uc01-01-bug-crash-null', ws, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(res.targetFixed).toBe(true);
    expect(res.noRegressions).toBe(false);
    expect(res.invariantErrors.length).toBeGreaterThan(0);
    expect(res.overallPassed).toBe(false);
  });

  test('F2 counterexample 2: pytest collection error (exit 2) fails verification', () => {
    const ws = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws, 'tinydb_demo/pretty.py'),
      "def render_table(rows):\n    if not rows:\n        return ''\n    headers = list(rows[0])\n    widths = [len(header) for header in headers]\n    return '  '.join(_pad_header(header, width) for header, width in zip(headers, widths))\n\n\ndef _pad_header(header, width):\n    return header.ljust(width)\n",
    );
    fs.writeFileSync(path.join(ws, 'tests/test_broken_collect.py'), 'def broken(:\n');
    const res = verifyWorkspace('uc01-03-bug-reproducible', ws, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(res.pytestExitCode).toBe(2);
    expect(res.noRegressions).toBe(false);
    expect(res.overallPassed).toBe(false);
  });

  test('F2 counterexample 3: weakening or deleting existing test fails testIntegrity', () => {
    const ws = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws, 'tinydb_demo/format.py'),
      "def format_tags(note):\n    return ', '.join(sorted(note.get('tags') or []))\n",
    );
    fs.rmSync(path.join(ws, 'tests/test_search.py'));
    const res = verifyWorkspace('uc01-01-bug-crash-null', ws, { baselinePytest: baseline, fixtureDir: FIXTURE_DIR });
    expect(res.testIntegrity.ok).toBe(false);
    expect(res.noRegressions).toBe(false);
    expect(res.overallPassed).toBe(false);
  });

  test('agentStatus timeout or error blocks overallPassed even when target is fixed', () => {
    const ws = makeTempFixtureCopy();
    fs.writeFileSync(
      path.join(ws, 'tinydb_demo/format.py'),
      "def format_tags(note):\n    return ', '.join(sorted(note.get('tags') or []))\n",
    );
    const res = verifyWorkspace('uc01-01-bug-crash-null', ws, {
      baselinePytest: baseline,
      fixtureDir: FIXTURE_DIR,
      agentStatus: 'timeout',
    });
    expect(res.targetFixed).toBe(true);
    expect(res.agentStatus).toBe('timeout');
    expect(res.overallPassed).toBe(false);
  });
});

describe('F3: Controlled Execution Parity', () => {
  test('Arm A and Arm B share identical execution policy in controlled mode', () => {
    const fakePlan = { kind: 'bwrap' as const, detail: 'bwrap' };
    const a = getExecutionPolicySnapshot('controlled', 'A_baseline', fakePlan);
    const b = getExecutionPolicySnapshot('controlled', 'B_ms', fakePlan);

    expect(a.shell).toBe(b.shell);
    expect(a.pythonBin).toBe(b.pythonBin);
    expect(a.timeoutMs).toBe(b.timeoutMs);
    expect(a.envScrubbed).toBe(true);
    expect(b.envScrubbed).toBe(true);
    expect(a.sandboxKind).toBe(b.sandboxKind);
    expect(a.targetValidation).toBe(true);
    expect(b.targetValidation).toBe(true);
    expect(a.destructiveGuard).toBe(true);
    expect(b.destructiveGuard).toBe(true);
  });

  test('validatePytestTarget and destructiveReason block unsafe targets/commands', () => {
    const ws = makeTempFixtureCopy();
    expect(() => validatePytestTarget(ws, '-k foo')).toThrow();
    expect(() => validatePytestTarget(ws, '../outside.py')).toThrow();
    expect(() => validatePytestTarget(ws, '/etc/passwd')).toThrow();
    expect(validatePytestTarget(ws, 'tests/test_search.py::test_search_is_case_insensitive')).toBe(
      'tests/test_search.py::test_search_is_case_insensitive',
    );
    expect(destructiveReason('rm -rf /')).not.toBeNull();
  });

  test('buildControlledPytestInvocation executes pytest inside sandbox without missing site-packages', () => {
    const ws = makeTempFixtureCopy();
    const plan = planSandbox(ws, { allowUnsandboxed: true });
    const inv = buildControlledPytestInvocation(ws, 'tests/test_search.py', plan);
    const res = spawnSync(inv.file, inv.args, { cwd: ws, encoding: 'utf8', timeout: 15_000 });
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    expect(combined).not.toContain('No module named pytest');
    expect(combined).toContain('test_search_is_case_insensitive');
  });

  test('registerMsTools prunes ms_outline/ms_context/ms_undo by default and keeps them opt-in', () => {
    const regDefault = new ToolRegistry();
    registerMsTools(regDefault, {} as MsAxiomAdapter, 's1', 'ms', 'controlled');
    const namesDefault = regDefault.getDefinitions().map((d) => d.name);
    expect(namesDefault).not.toContain('ms_outline');
    expect(namesDefault).not.toContain('ms_context');
    expect(namesDefault).not.toContain('ms_undo');
    expect(namesDefault).toContain('read_file');
    expect(namesDefault).toContain('edit');
    expect(namesDefault).toContain('write_file');
    expect(namesDefault).toContain('list_dir');
    expect(namesDefault).toContain('search_code');
    expect(namesDefault).toContain('run_command');
    expect(namesDefault).toContain('run_tests');

    const regOptIn = new ToolRegistry();
    registerMsTools(regOptIn, {} as MsAxiomAdapter, 's1', 'ms', 'controlled', undefined, { includeExtraTools: true });
    const namesOptIn = regOptIn.getDefinitions().map((d) => d.name);
    expect(namesOptIn).toContain('ms_outline');
    expect(namesOptIn).toContain('ms_context');
    expect(namesOptIn).toContain('ms_undo');
  });

  test('distillCommandOutput preserves short passing output and attaches snippets on failure', () => {
    const shortRaw = Array.from({ length: 8 }, (_, i) => `row-${i + 1}`).join('\n');
    const okRes = distillCommandOutput(shortRaw, { exitCode: 0, timedOut: false, durationMs: 12, kind: 'generic' });
    for (let i = 1; i <= 8; i++) {
      expect(okRes.output).toContain(`row-${i}`);
    }

    const failRaw = '==== FAILURES ====\nE   AssertionError: boom\nFAILED tests/test_a.py::test_1';
    const failRes = distillCommandOutput(failRaw, {
      exitCode: 1,
      timedOut: false,
      durationMs: 30,
      kind: 'pytest',
      snippets: ['@ tests/test_a.py:3\n3:abcd| assert False'],
    });
    expect(failRes.output).toContain('[FAILED | exit:1');
    expect(failRes.output).toContain('--- context snippets ---');
    expect(failRes.output).toContain('3:abcd| assert False');
  });

  test('distillCommandOutput never emits pytest passed on piped exitCode 0 with failure or collection errors', () => {
    const tailPipedFailure = [
      ...Array.from({ length: 18 }, (_, i) => `collecting ... item ${i + 1}`),
      '==== ERRORS ====',
      'ERROR collecting tests/test_broken.py',
      'Traceback (most recent call last):',
      '  File "tests/test_broken.py", line 2, in <module>',
      '    import missing_pkg',
      "ModuleNotFoundError: No module named 'missing_pkg'",
      '==== short test summary info ====',
      'ERROR tests/test_broken.py',
    ].join('\n');

    const tailRes = distillCommandOutput(tailPipedFailure, {
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
      kind: 'pytest',
      snippets: ['@ tests/test_broken.py:2\n2:abcd| import missing_pkg'],
    });
    expect(tailRes.hasFailures).toBe(true);
    expect(tailRes.output).not.toContain('pytest passed');
    expect(tailRes.output).toContain('[FAILED | exit:0');
    expect(tailRes.output).toContain('ModuleNotFoundError');
    expect(tailRes.output).toContain('ERROR collecting tests/test_broken.py');
    expect(tailRes.output).toContain('--- context snippets ---');
    expect(tailRes.output).toContain('2:abcd| import missing_pkg');

    const headPipedFailure = [
      '==== test session starts ====',
      ...Array.from({ length: 20 }, (_, i) => `tests/test_a.py::test_${i + 1} PASSED`),
      '==== FAILURES ====',
      'E   AssertionError: expected 1 == 2',
      'FAILED tests/test_a.py::test_21 - AssertionError',
    ].join('\n');

    const headFailRes = distillCommandOutput(headPipedFailure, {
      exitCode: 0,
      timedOut: false,
      durationMs: 55,
      kind: 'pytest',
      snippets: ['@ tests/test_a.py:10\n10:ef12| assert 1 == 2'],
    });
    expect(headFailRes.hasFailures).toBe(true);
    expect(headFailRes.output).not.toContain('pytest passed');
    expect(headFailRes.output).toContain('[FAILED | exit:0');
    expect(headFailRes.output).toContain('AssertionError: expected 1 == 2');
    expect(headFailRes.output).toContain('FAILED tests/test_a.py::test_21');
    expect(headFailRes.output).toContain('10:ef12| assert 1 == 2');

    const headTruncatedPass = Array.from({ length: 25 }, (_, i) => `tests/test_a.py::test_${i + 1} PASSED`).join('\n');
    const headPassRes = distillCommandOutput(headTruncatedPass, {
      exitCode: 0,
      timedOut: false,
      durationMs: 25,
      kind: 'pytest',
    });
    expect(headPassRes.hasFailures).toBe(false);
    expect(headPassRes.output).not.toContain('pytest passed');
    expect(headPassRes.output).toContain('test_25 PASSED');

    const tailTruncatedSummary = [
      ...Array.from({ length: 18 }, (_, i) => `step ${i + 1}`),
      '>       assert actual == expected',
      'E       AssertionError: assert 1 == 2',
      '=== 1 failed, 2 passed in 0.12s ===',
    ].join('\n');
    const tailSummaryRes = distillCommandOutput(tailTruncatedSummary, {
      exitCode: 0,
      timedOut: false,
      durationMs: 30,
      kind: 'pytest',
    });
    expect(tailSummaryRes.hasFailures).toBe(true);
    expect(tailSummaryRes.output).not.toContain('pytest passed');
    expect(tailSummaryRes.output).toContain('assert actual == expected');
    expect(tailSummaryRes.output).toContain('1 failed, 2 passed');
  });

  test('MsAxiomAdapter.exec runs in-process, handles shell metacharacters, and attaches hashline snippets even via symlinked root', async () => {
    const msBin = path.resolve(import.meta.dir, '..', 'target', 'release', 'ms');
    if (!fs.existsSync(msBin)) {
      throw new Error(`release binary missing at ${msBin}`);
    }
    const realWs = makeTempDir('ab-exec-real-');
    const linkParent = makeTempDir('ab-exec-link-');
    const linkWs = path.join(linkParent, 'ws-link');
    fs.symlinkSync(realWs, linkWs);
    const stateDir = makeTempDir('ab-exec-state-');
    fs.writeFileSync(path.join(realWs, 'app.py'), 'def broken():\n    return 1 / 0\n', 'utf8');

    const adapter = new MsAxiomAdapter(msBin, linkWs, stateDir, false);
    try {
      await adapter.initialize();
      const sessionId = await adapter.openSession({ allowWrite: false });

      const okRes = await adapter.exec('echo hello_world', { sessionId });
      expect(okRes.exitCode).toBe(0);
      expect(okRes.output).toContain('hello_world');

      const metaRes = await adapter.exec('FOO=ok;echo:$FOO', { sessionId });
      expect(metaRes.exitCode).toBe(127);

      const errPath = path.join(fs.realpathSync(realWs), 'app.py');
      const failRes = await adapter.exec(
        ['python3', '-c', `import sys; print('File "${errPath}", line 2, in broken'); sys.exit(1)`],
        { sessionId },
      );
      expect(failRes.exitCode).toBe(1);
      expect(failRes.output).toContain('--- context snippets ---');
      expect(failRes.output).toContain('return 1 / 0');

      await adapter.closeSession(sessionId);
    } finally {
      adapter.shutdown();
    }
  });
});

describe('F4, F5, F6: Schedule, Resume, Infra Errors, Diff & Redaction', () => {
  test('buildExperimentSchedule is deterministic and counterbalances AB/BA', () => {
    const s1 = buildExperimentSchedule(['c1', 'c2', 'c3'], 2, 42);
    const s2 = buildExperimentSchedule(['c1', 'c2', 'c3'], 2, 42);
    expect(s1).toEqual(s2);
    expect(s1.length).toBe(12);
    const pairOrders = new Set(s1.map((r) => r.pairOrder));
    expect(pairOrders.has('AB')).toBe(true);
    expect(pairOrders.has('BA')).toBe(true);
  });

  test('resume skips completed runIds without duplication and records per-run exceptions as infra_error', async () => {
    const outDir = makeTempDir('ab-resume-test-');
    const opts = parseCliArgs([
      '--trials',
      '1',
      '--seed',
      '42',
      '--mode',
      'controlled',
      '--out-dir',
      outDir,
      '--cases',
      'uc01-01-bug-crash-null',
    ]);

    let calls = 0;
    const firstPass = await runExperiment(opts, {
      runSingleFn: async (scheduled) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('simulated setup failure');
        }
        // Simulate partial interruption after recording 1st run by throwing on 2nd? No, let's let 1st record infra_error and 2nd succeed,
        // then test resume with a pre-seeded partial jsonl.
        return {
          schemaVersion: '2.0.0',
          experimentId: 'exp',
          runId: scheduled.runId,
          trial: scheduled.trial,
          caseId: scheduled.caseId,
          arm: scheduled.arm,
          pairOrder: scheduled.pairOrder,
          mode: 'controlled',
          recordedAt: new Date().toISOString(),
          status: 'completed',
          agentStatus: 'ok',
          verified: {
            passed: false,
            overallPassed: false,
            targetFixed: false,
            noRegressions: true,
            verificationComplete: true,
            agentStatus: 'ok',
            details: '',
            regressionReasons: [],
            invariantErrors: [],
            testIntegrity: { ok: true, tamperingReasons: [], modifiedExistingTestFiles: [], addedTestFiles: [] },
            pytestExitCode: 1,
            pytestSummary: '',
            pytest: { passed: [], failed: [], skipped: [], errors: [], complete: true, timedOut: false, exitCode: 1, summary: '' },
          },
          durationsMs: { setupMs: 1, agentMs: 2, verifyMs: 3, cleanupMs: 1, wallClockMs: 7 },
          wallClockMs: 7,
          llmTurns: 1,
          toolCallsTotal: 1,
          toolFailures: 0,
          commandNonZeroExits: 0,
          commandTimeouts: 0,
          toolOutputBytesTotal: 10,
          toolErrors: [],
          toolCallsByName: {},
          usage: {
            uncachedInput: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWriteType: 'ephemeral_5m',
            output: 5,
            totalInputAll: 10,
            totalTokens: 15,
          },
          costDollars: 0.000004,
          costKind: 'estimated',
          pricingCanonicalId: 'claude-haiku-5.5',
          filesChangedAgent: [],
          filesChangedActual: [],
          tracePath: '',
          patchPath: '',
        };
      },
    });

    expect(firstPass.runs.length).toBe(2);
    expect(firstPass.runs[0]!.status).toBe('infra_error');
    expect(firstPass.runs[0]!.infraError).toContain('simulated setup failure');
    expect(firstPass.runs[1]!.status).toBe('completed');

    // Now test partial JSONL + --resume: keep only first line, resume, verify 2nd runs once and 1st is not duplicated
    const jsonlPath = path.join(outDir, 'runs.jsonl');
    const allLines = loadRunRecords(jsonlPath);
    fs.writeFileSync(jsonlPath, JSON.stringify(allLines[0]) + '\n', 'utf8');

    let resumedCalls = 0;
    const resumeOpts = parseCliArgs(['--resume', outDir, '--cases', 'uc01-01-bug-crash-null']);
    const resumed = await runExperiment(resumeOpts, {
      runSingleFn: async (scheduled) => {
        resumedCalls += 1;
        return {
          ...(allLines[1] as RunRecord),
          runId: scheduled.runId,
        };
      },
    });

    expect(resumedCalls).toBe(1);
    expect(resumed.runs.length).toBe(2);
    expect(new Set(resumed.runs.map((r) => r.runId)).size).toBe(2);
  });

  test('computeWorkspaceDiff captures edits made via shell outside RPC/Axiom tools', () => {
    const ws = makeTempFixtureCopy();
    fs.writeFileSync(path.join(ws, 'shell_created.txt'), 'created via shell\n');
    fs.appendFileSync(path.join(ws, 'tinydb_demo/format.py'), '\n# shell edit\n');

    const diff = computeWorkspaceDiff(FIXTURE_DIR, ws);
    expect(diff.filesChanged).toContain('shell_created.txt');
    expect(diff.filesChanged).toContain('tinydb_demo/format.py');
    expect(diff.diffText).toContain('created via shell');
    expect(diff.diffText).toContain('# shell edit');
  });

  test('secrets are redacted in config snapshot and tool trace entries', () => {
    const fakeSecret = 'sk-ant-test-super-secret-token-987654321';
    registerSecret(fakeSecret);

    const redactedCfg = redactConfigObject({
      apiKey: fakeSecret,
      nested: { authToken: 'abc', note: `leak ${fakeSecret}` },
    }) as Record<string, unknown>;
    expect(JSON.stringify(redactedCfg)).not.toContain(fakeSecret);
    expect(redactedCfg.apiKey).toBe('‹redacted›');

    const trace = buildToolTraceEntry(
      'call_1',
      'run_command',
      10,
      25,
      `[OK | exit:0 | 10ms | log:x | raw:1L/10B]\n${fakeSecret}`,
      false,
    );
    expect(trace.exitCode).toBe(0);
    expect(trace.timedOut).toBe(false);
    expect(trace.toolOutputBytes).toBeGreaterThan(0);

    const errTrace = buildToolTraceEntry('call_2', 'run_command', 20, 50, `failed with ${fakeSecret}`, true, `err ${fakeSecret}`);
    expect(errTrace.errorPreview).not.toContain(fakeSecret);
  });

  test('manifest records toolDefinitionsSha256 and --resume hydrates manifest config', async () => {
    const outDir = makeTempDir('ab-hydrate-test-');
    const opts = parseCliArgs([
      '--trials',
      '1',
      '--seed',
      '7',
      '--mode',
      'native',
      '--max-steps',
      '12',
      '--budget',
      '0.45',
      '--out-dir',
      outDir,
      '--cases',
      'uc01-01-bug-crash-null',
      '--dry-run',
    ]);
    const initial = await runExperiment(opts);
    expect(initial.manifest.hashes.toolDefinitionsSha256?.A_baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.manifest.hashes.toolDefinitionsSha256?.B_ms).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.manifest.hashes.toolDefinitionsSha256?.A_baseline).not.toBe(
      initial.manifest.hashes.toolDefinitionsSha256?.B_ms,
    );

    const seenModes: string[] = [];
    const seenMaxSteps: number[] = [];
    const resumeOpts = parseCliArgs(['--resume', outDir]);
    await runExperiment(resumeOpts, {
      runSingleFn: async (scheduled, _fixture, ctx) => {
        seenModes.push(ctx.opts.mode);
        seenMaxSteps.push(ctx.opts.maxSteps);
        return buildInfraErrorRecord(scheduled, ctx.experimentId, ctx.opts.mode, 'unknown-model-id', new Error('stop'), 1);
      },
    });
    expect(seenModes).toEqual(['native', 'native']);
    expect(seenMaxSteps).toEqual([12, 12]);
  });

  test('trace entry records turnIndex, truncated, originalBytes, sha256, and redacts secrets in args & output', () => {
    const secret = 'sk-test-trace-redaction-1234567890';
    registerSecret(secret);

    const longCmd = `pytest -q ${secret} ${'a'.repeat(700)}`;
    const longOut = `PASS ${secret} ${'b'.repeat(1200)}`;
    const entry = buildToolTraceEntry('tc-1', 'run_command', 12.34, 45.67, longOut, false, undefined, {
      turnIndex: 3,
      args: { command: longCmd, apiKey: secret },
    });

    expect(entry.turnIndex).toBe(3);
    expect(entry.argsTruncated).toBe(true);
    expect(entry.argsOriginalBytes).toBeGreaterThan(512);
    expect(entry.argsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.argsPreview).not.toContain(secret);
    expect(entry.argsPreview).toContain('‹redacted›');

    expect(entry.outputTruncated).toBe(true);
    expect(entry.outputOriginalBytes).toBeGreaterThan(1024);
    expect(entry.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.outputPreview).not.toContain(secret);

    const shortEntry = buildToolTraceEntry('tc-2', 'read_file', 1, 2, 'hello', false, undefined, {
      turnIndex: 1,
      args: { path: 'tiny.py' },
    });
    expect(shortEntry.argsTruncated).toBe(false);
    expect(shortEntry.outputTruncated).toBe(false);
    expect(shortEntry.argsSha256).toBe(crypto.createHash('sha256').update('{"path":"tiny.py"}').digest('hex'));
    expect(shortEntry.outputSha256).toBe(crypto.createHash('sha256').update('hello').digest('hex'));
  });

  test('manifest records systemPromptSha256, bundledSkillSha256, featureFlags, featureConfigSha256 and hydrates --bundled-skill-mode on --resume', async () => {
    const outDir = makeTempDir('ab-v3a-manifest-');
    const opts = parseCliArgs([
      '--trials',
      '1',
      '--seed',
      '11',
      '--mode',
      'controlled',
      '--bundled-skill-mode',
      'off',
      '--out-dir',
      outDir,
      '--cases',
      'uc01-01-bug-crash-null',
      '--dry-run',
    ]);
    const initial = await runExperiment(opts);
    expect(initial.manifest.hashes.systemPromptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.manifest.hashes.bundledSkillSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.manifest.hashes.featureConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.manifest.featureFlags).toEqual({ bundledSkillMode: 'off' });

    const seenSkillModes: string[] = [];
    const resumeOpts = parseCliArgs(['--resume', outDir]);
    await runExperiment(resumeOpts, {
      runSingleFn: async (scheduled, _fixture, ctx) => {
        seenSkillModes.push(ctx.opts.bundledSkillMode);
        return buildInfraErrorRecord(scheduled, ctx.experimentId, ctx.opts.mode, 'unknown-model-id', new Error('stop'), 1);
      },
    });
    expect(seenSkillModes).toEqual(['off', 'off']);
  });
});

describe('v3a: Shared Bundled Skill Resolver (Workspace-First + Allowlist)', () => {
  const MS_BIN = '/home/hoang/ms/target/release/ms';

  async function setupMsArm(ws: string, bundledSkillMode: 'on' | 'off') {
    const stateDir = makeTempDir('ab-skill-ms-state-');
    const adapter = new MsAxiomAdapter(MS_BIN, ws, stateDir, true);
    const sessionId = await adapter.openSession({ allowWrite: false });
    const reg = new ToolRegistry();
    reg.allowWithoutApprover = true;
    registerMsTools(reg, adapter, sessionId, MS_BIN, 'controlled', planSandbox(), { bundledSkillMode });
    return { adapter, sessionId, reg };
  }

  function setupBaselineArm(bundledSkillMode: 'on' | 'off') {
    const reg = new ToolRegistry();
    reg.allowWithoutApprover = true;
    registerBaselineTools(reg, bundledSkillMode);
    return reg;
  }

  test('workspace skills/bug-fix/SKILL.md shadows bundled skill in both A_baseline and B_ms', async () => {
    const ws = makeTempFixtureCopy();
    const skillDir = path.join(ws, 'skills', 'bug-fix');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# WORKSPACE SHADOW SKILL\ncustom-marker-xyz\n', 'utf8');

    const baseReg = setupBaselineArm('on');
    const baseRes = await baseReg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
    expect(baseRes.isError).toBe(false);
    expect(baseRes.output).toContain('WORKSPACE SHADOW SKILL');
    expect(baseRes.output).toContain('custom-marker-xyz');

    const { adapter, sessionId, reg: msReg } = await setupMsArm(ws, 'on');
    try {
      const msRes = await msReg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(msRes.isError).toBe(false);
      expect(msRes.output).toContain('WORKSPACE SHADOW SKILL');
      expect(msRes.output).toContain('custom-marker-xyz');
    } finally {
      await adapter.closeSession(sessionId).catch(() => {});
      adapter.shutdown();
    }
  });

  test('missing skills/bug-fix/SKILL.md falls back to bundled skill when bundledSkillMode=on and fails when off', async () => {
    const ws = makeTempFixtureCopy();

    const baseOn = setupBaselineArm('on');
    const baseOnRes = await baseOn.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
    expect(baseOnRes.isError).toBe(false);
    expect(baseOnRes.output).toContain('bug-fix');

    const baseOff = setupBaselineArm('off');
    const baseOffRes = await baseOff.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
    expect(baseOffRes.isError).toBe(true);
    expect(baseOffRes.output).toContain('File or directory not found');

    const msOn = await setupMsArm(ws, 'on');
    try {
      const msOnRes = await msOn.reg.executeTool('read_file', { path: './skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(msOnRes.isError).toBe(false);
      expect(msOnRes.output).toMatch(/^1\t# Skill: bug-fix/);
      expect(msOnRes.output).not.toContain('rev:');
      expect(msOnRes.output).toContain('bug-fix');
    } finally {
      await msOn.adapter.closeSession(msOn.sessionId).catch(() => {});
      msOn.adapter.shutdown();
    }

    const msOff = await setupMsArm(ws, 'off');
    try {
      const msOffRes = await msOff.reg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(msOffRes.output).toContain('E_NOT_FOUND');
    } finally {
      await msOff.adapter.closeSession(msOff.sessionId).catch(() => {});
      msOff.adapter.shutdown();
    }
  });

  test('non-allowlisted paths, traversal escapes, symlinks, and permission errors do NOT fall back to bundled skill', async () => {
    const ws = makeTempFixtureCopy();

    expect(resolveAllowlistedBundledSkill('skills/other/SKILL.md', ws)).toBeNull();
    expect(resolveAllowlistedBundledSkill('../../skills/bug-fix/SKILL.md', ws)).toBeNull();
    expect(resolveAllowlistedBundledSkill('/etc/passwd', ws)).toBeNull();
    expect(resolveAllowlistedBundledSkill('skills/bug-fix/SKILL.md', ws)).not.toBeNull();

    // 1. Root-escaping traversal must fail in both arms
    const baseReg = setupBaselineArm('on');
    const escBase = await baseReg.executeTool('read_file', { path: '../../skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
    expect(escBase.isError).toBe(true);

    const msArm = await setupMsArm(ws, 'on');
    try {
      const escMs = await msArm.reg.executeTool('read_file', { path: '../../skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(escMs.isError).toBe(true);
      expect(escMs.output).toMatch(/Blocked by policy|E_POLICY_DENIED/);
      // Also verify MsReadTool directly when ms returns E_POLICY_DENIED
      const msReadTool = msArm.reg.getTool('read_file')!;
      const directEsc = await msReadTool.execute({ path: '../../skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(directEsc).toContain('E_POLICY_DENIED');

      // 2. Non-allowlisted relative path must fail
      const nonAllowMs = await msArm.reg.executeTool('read_file', { path: 'skills/nonexistent/SKILL.md' }, { workspaceRoot: ws });
      expect(nonAllowMs.output).toContain('E_NOT_FOUND');

      // 3. Broken symlink at skills/bug-fix/SKILL.md must NOT trigger fallback
      const skillDir = path.join(ws, 'skills', 'bug-fix');
      fs.mkdirSync(skillDir, { recursive: true });
      const symlinkPath = path.join(skillDir, 'SKILL.md');
      fs.symlinkSync('/nonexistent/outside/SKILL.md', symlinkPath);

      const symBase = await baseReg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(symBase.isError).toBe(true);

      const symMs = await msArm.reg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
      expect(symMs.output).toContain('E_POLICY_DENIED');

      // 4. Permission error (chmod 000) must NOT trigger fallback
      fs.unlinkSync(symlinkPath);
      fs.writeFileSync(symlinkPath, 'secret', 'utf8');
      fs.chmodSync(symlinkPath, 0o000);
      try {
        const permBase = await baseReg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
        // Note: if running as root in container, chmod 000 might still be readable; only assert if not root
        if (process.getuid && process.getuid() !== 0) {
          expect(permBase.isError).toBe(true);
          const permMs = await msArm.reg.executeTool('read_file', { path: 'skills/bug-fix/SKILL.md' }, { workspaceRoot: ws });
          expect(permMs.output).toContain('E_POLICY_DENIED');
          expect(permMs.output).not.toContain('rev:');
        }
      } finally {
        fs.chmodSync(symlinkPath, 0o644);
      }
    } finally {
      await msArm.adapter.closeSession(msArm.sessionId).catch(() => {});
      msArm.adapter.shutdown();
    }
  });

  test('absolute allowlisted bundled skill path works in MsReadTool when bundledSkillMode=on and stays blocked when off', async () => {
    const ws = makeTempFixtureCopy();
    const absBundled = path.join(BUNDLED_SKILLS_DIR, 'bug-fix', 'SKILL.md');
    expect(resolveAllowlistedBundledSkill(absBundled, ws)).not.toBeNull();
    expect(resolveAllowlistedBundledSkill(path.join(BUNDLED_SKILLS_DIR, 'nonexistent', 'SKILL.md'), ws)).toBeNull();

    const msOn = await setupMsArm(ws, 'on');
    try {
      const res = await msOn.reg.executeTool('read_file', { path: absBundled }, { workspaceRoot: ws });
      expect(res.isError).toBe(false);
      expect(res.output).toContain('Skill: bug-fix');
      expect(res.output).toMatch(/^1\t# Skill: bug-fix/);
      expect(res.output).not.toContain('rev:');
    } finally {
      await msOn.adapter.closeSession(msOn.sessionId).catch(() => {});
      msOn.adapter.shutdown();
    }

    const msOff = await setupMsArm(ws, 'off');
    try {
      const res = await msOff.reg.executeTool('read_file', { path: absBundled }, { workspaceRoot: ws });
      expect(res.output).toContain('E_POLICY_DENIED');
    } finally {
      await msOff.adapter.closeSession(msOff.sessionId).catch(() => {});
      msOff.adapter.shutdown();
    }
  });
});

describe('Stage 1: Read-only inspection false-positive fix & unified readLog + GC', () => {
  const MS_BIN = '/home/hoang/ms/target/release/ms';

  test('rg "AssertionError" tests/ (exit 0) stays [OK | exit:0 ...], while piped pytest with failure markers (exit 0) becomes [FAILED | exit:0 ...]', () => {
    const rgOut = [
      'tests/test_a.py:12:    raise AssertionError("boom")',
      'tests/test_b.py:45:    # FAILED ERROR Traceback',
    ].join('\n');

    const rgRes = distillCommandOutput(rgOut, {
      exitCode: 0,
      timedOut: false,
      durationMs: 14,
      kind: 'generic',
      command: 'rg "AssertionError" tests/',
    });
    expect(rgRes.hasFailures).toBe(false);
    expect(rgRes.output).toContain('[OK | exit:0');
    expect(rgRes.output).not.toContain('[FAILED | exit:0');

    const rgPipePattern = distillCommandOutput(rgOut, {
      exitCode: 0,
      timedOut: false,
      durationMs: 15,
      kind: 'generic',
      command: 'rg "FAILED|AssertionError" tests/',
    });
    expect(rgPipePattern.hasFailures).toBe(false);
    expect(rgPipePattern.output).toContain('[OK | exit:0');

    const pipedPytest = [
      ...Array.from({ length: 18 }, (_, i) => `collecting ... item ${i + 1}`),
      'E   AssertionError: 1 != 2',
      'FAILED tests/test_a.py::test_1',
    ].join('\n');
    const pipedRes = distillCommandOutput(pipedPytest, {
      exitCode: 0,
      timedOut: false,
      durationMs: 22,
      kind: 'pytest',
      command: 'pytest -q | tail -30',
    });
    expect(pipedRes.hasFailures).toBe(true);
    expect(pipedRes.output).toContain('[FAILED | exit:0');

    const cmdSubst = distillCommandOutput('FAILED: boom', {
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      kind: 'generic',
      command: 'echo "$(printf FAILED)"',
    });
    expect(cmdSubst.hasFailures).toBe(true);
    expect(cmdSubst.output).toContain('[FAILED | exit:0');
  });

  test('MsAxiomAdapter.exec persists raw logs on distilled/truncated output and adapter.readLog reads them + GC cleans old/excess logs', async () => {
    const ws = makeTempDir('ab-log-ws-');
    const stateDir = makeTempDir('ab-log-state-');
    const logDir = makeTempDir('ab-log-dir-');

    // Seed an expired log (>24h) to verify GC runs on persist
    const oldLog = path.join(logDir, 'old-expired.log');
    fs.writeFileSync(oldLog, '# cmd: old\nexpired\n', 'utf8');
    const oldDate = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(oldLog, oldDate, oldDate);

    const adapter = new MsAxiomAdapter(MS_BIN, ws, stateDir, false, { logDir });
    try {
      await adapter.initialize();
      const sessionId = await adapter.openSession({ allowWrite: false });

      const execRes = await adapter.exec(
        ['python3', '-c', 'for i in range(1, 35): print(f"row-{i:02d}")'],
        { sessionId },
      );
      expect(execRes.exitCode).toBe(0);
      expect(execRes.output).toContain('[OK | exit:0');
      expect(execRes.output).toMatch(/\| log:(log-[^\s|\]]+) \|/);
      expect(execRes.logId).toBeDefined();

      // Expired log should have been GC'd when exec persisted the new log
      expect(fs.existsSync(oldLog)).toBe(false);

      const logContent = await adapter.readLog(execRes.logId!, { tail: 10, grep: 'row-30' });
      expect(logContent).toContain('row-30');
      expect(logContent).toContain(`log:${execRes.logId}`);

      // Also verify `log:<id>` prefixed form works consistently
      const prefixedLogContent = await adapter.readLog(`log:${execRes.logId!}`, { tail: 5, grep: 'row-30' });
      expect(prefixedLogContent).toContain('row-30');

      // Verify `rg "pytest" ...` via MsAxiomAdapter.exec is not misclassified as pytest
      fs.writeFileSync(path.join(ws, 'sample.py'), '# pytest FAILED AssertionError\n', 'utf8');
      const rgPytestRes = await adapter.exec(['rg', '--no-heading', 'pytest', 'sample.py'], { sessionId });
      expect(rgPytestRes.exitCode).toBe(0);
      expect(rgPytestRes.output).toContain('[OK | exit:0');
      expect(rgPytestRes.output).not.toContain('[FAILED | exit:0');

      await adapter.closeSession(sessionId);
    } finally {
      adapter.shutdown();
    }

    // Verify gcLogDir count cap
    for (let i = 0; i < 6; i++) {
      const p = path.join(logDir, `cap-${i}.log`);
      fs.writeFileSync(p, `line ${i}\n`, 'utf8');
      const t = new Date(Date.now() - (6 - i) * 1000);
      fs.utimesSync(p, t, t);
    }
    const removed = gcLogDir(logDir, 24 * 3600 * 1000, 3);
    expect(removed).toBeGreaterThanOrEqual(3);
    const remainingLogs = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
    expect(remainingLogs.length).toBe(3);
  });
});

describe('v4a & v4b: Snapshot-bound short rev alias, post-edit snippet, and 25-line pass-through', () => {
  const MS_BIN = '/home/hoang/ms/target/release/ms';

  test('RevisionAliasRegistry binds 8-char alias to exact snapshot and rejects stale edits after external change', async () => {
    const ws = makeTempFixtureCopy();
    const stateDir = makeTempDir('ab-v4a-state-');
    const adapter = new MsAxiomAdapter(MS_BIN, ws, stateDir, true);
    try {
      await adapter.initialize();
      const sessionId = await adapter.openSession({ allowWrite: true });
      const registry = new ToolRegistry();
      registerMsTools(registry, adapter, sessionId, MS_BIN, 'controlled', planSandbox());

      const readTool = registry.getTool('read_file')!;
      const editTool = registry.getTool('edit')!;
      const writeTool = registry.getTool('write_file')!;

      const readOut = await readTool.execute({ path: 'tinydb_demo/format.py' }, { workspaceRoot: ws });
      const revMatch = readOut.match(/^rev:([0-9a-f]{8})\s+/);
      expect(revMatch).not.toBeNull();
      const alias1 = revMatch![1]!;

      // Edit with snapshot alias succeeds and returns new 8-char rev + 7-line inline snippet
      const editOk = await editTool.execute(
        {
          path: 'tinydb_demo/format.py',
          expectedRevision: alias1,
          oldText: "return ', '.join(sorted(note['tags']))",
          newText: "return ', '.join(sorted(note.get('tags') or []))",
        },
        { workspaceRoot: ws },
      );
      expect(editOk).toContain('Edited tinydb_demo/format.py (rev:');
      expect(editOk).not.toContain('rev:ok');
      const postRevMatch = editOk.match(/\(rev:([0-9a-f]{8}),\s*tx:/);
      expect(postRevMatch).not.toBeNull();
      const alias2 = postRevMatch![1]!;
      expect(alias2).not.toBe(alias1);
      expect(editOk).toContain('lines:');

      // External modification on disk invalidates alias2 -> must return E_CONFLICT
      const targetFile = path.join(ws, 'tinydb_demo/format.py');
      fs.appendFileSync(targetFile, '\n# external change\n', 'utf8');
      const staleRes = await editTool.execute(
        {
          path: 'tinydb_demo/format.py',
          expectedRevision: alias2,
          oldText: '# external change',
          newText: '# should fail',
        },
        { workspaceRoot: ws },
      );
      expect(staleRes).toContain('E_CONFLICT');

      // write_file returns short alias + line/byte counts
      const writeOut = await writeTool.execute(
        { path: 'tinydb_demo/tmp_note.py', content: 'a = 1\nb = 2\n' },
        { workspaceRoot: ws },
      );
      expect(writeOut).toMatch(/Wrote tinydb_demo\/tmp_note\.py \(rev:[0-9a-f]{8}, lines:3, bytes:12, tx:/);

      await adapter.closeSession(sessionId);
    } finally {
      adapter.shutdown();
    }
  });

  test('RevisionAliasRegistry disambiguates prefix collisions cleanly', () => {
    const reg = new RevisionAliasRegistry();
    const revA = 'a'.repeat(64);
    const revB = 'a'.repeat(8) + 'b'.repeat(56);
    const aliasA = reg.register('f.py', revA);
    const aliasB = reg.register('f.py', revB);
    expect(aliasA).toBe('aaaaaaaa');
    expect(aliasB).toBe('aaaaaaaabb');
    expect(reg.resolve('f.py', aliasA)).toBe(revA);
    expect(reg.resolve('f.py', aliasB)).toBe(revB);
  });

  test('distillCommandOutput preserves 25-line passing output under 1500B verbatim', () => {
    const lines = Array.from({ length: 24 }, (_, i) => `item-${i + 1}: ok`);
    const res = distillCommandOutput(lines.join('\n'), {
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
      kind: 'generic',
      command: 'python3 -c "print(...)"',
    });
    expect(res.hasFailures).toBe(false);
    expect(res.output).toContain('[OK | exit:0');
    expect(res.output).toContain('item-1: ok');
    expect(res.output).toContain('item-24: ok');
  });

  test('list_dir enforces depth during Rust traversal before maxEntries truncation', async () => {
    const ws = makeTempFixtureCopy();
    fs.mkdirSync(path.join(ws, 'aaa_deep', 'd1', 'd2'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'aaa_deep', 'd1', 'f1.py'), 'x = 1\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'aaa_deep', 'd1', 'd2', 'f2.py'), 'y = 2\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'zzz_shallow.py'), 'z = 3\n', 'utf8');

    const stateDir = makeTempDir('ab-list-depth-state-');
    const adapter = new MsAxiomAdapter(MS_BIN, ws, stateDir, false);
    try {
      await adapter.initialize();
      const sessionId = await adapter.openSession({ allowWrite: false });
      const reg = new ToolRegistry();
      registerMsTools(reg, adapter, sessionId, MS_BIN, 'controlled', planSandbox());
      const res = await reg.executeTool(
        'list_dir',
        { path: '.', depth: 1, maxEntries: 10 },
        { workspaceRoot: ws },
      );
      expect(res.isError).toBe(false);
      expect(res.output).toContain('aaa_deep/');
      expect(res.output).toContain('zzz_shallow.py');
      expect(res.output).not.toContain('aaa_deep/d1');
      expect(res.output).not.toContain('f2.py');
      await adapter.closeSession(sessionId).catch(() => {});
    } finally {
      adapter.shutdown();
    }
  });

  test('attachFailureSnippetsViaRpc skips failures already having assertion context and attaches truncated ones', async () => {
    const ws = makeTempFixtureCopy();
    const stateDir = makeTempDir('ab-snippet-gate-state-');
    const adapter = new MsAxiomAdapter(MS_BIN, ws, stateDir, false);
    try {
      await adapter.initialize();
      const sessionId = await adapter.openSession({ allowWrite: false });
      const cleanedLines = [
        'tests/test_search.py:7: AssertionError',
        'E   assert 1 == 2',
        'tinydb_demo/format.py:4: TypeError',
      ];
      const renderedOutput = [
        '[FAILED | exit:1 | 50ms | raw:40L/2100B]',
        '>   assert len(store.search("hello")) == 1',
        'E   AssertionError: assert 0 == 1',
        'tests/test_search.py:7: AssertionError',
        'FAILED tinydb_demo/format.py:4',
      ].join('\n');

      const snippets = await attachFailureSnippetsViaRpc(adapter, sessionId, ws, cleanedLines, {
        renderedOutput,
      });
      const joined = snippets.join('\n');
      expect(joined).not.toContain('@ tests/test_search.py:7');
      expect(joined).toContain('@ tinydb_demo/format.py:4');
      await adapter.closeSession(sessionId).catch(() => {});
    } finally {
      adapter.shutdown();
    }
  });
});
