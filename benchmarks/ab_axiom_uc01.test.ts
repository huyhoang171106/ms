import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  buildToolTraceEntry,
  getExecutionPolicySnapshot,
  validatePytestTarget,
} from './ab_axiom_tools.js';
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
});
