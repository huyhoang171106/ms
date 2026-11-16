/**
 * A/B: Axiom's eight file/shell tools vs one `ms` tool.
 *
 *   TROLLLLM_API_KEY=... bun benchmarks/ab_single_tool.ts --pack medium --trials 1 --max-steps 40
 *   bun benchmarks/ab_single_tool.ts --recompute benchmarks/artifacts/<experiment>
 *
 * Arms:
 *   A_eight  ToolRegistry() - run_command, read_file, write_file, edit, apply_patch, list_dir, search_code, run_tests
 *   B_one    ToolRegistry(['ms']) - the single code-mode tool from integrations/axiom
 *
 * Packs:
 *   uc01    3 independent single-bug cases (short tasks)
 *   medium  taskflow: 4 failing tests in 3 subsystems, 120 passing tests to keep green (long task)
 *
 * Both arms get the same model, system prompt, task text, max steps and workspace. Trials are counterbalanced
 * AB/BA so a warm provider cache cannot favour one arm.
 *
 * The oracle is independent of the agent workspace: required tests must pass, no test that passed at baseline may
 * fail afterwards, no collection error, and every guarded file (tests/, pytest.ini) must be byte-identical.
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../../nhom-30/axiom-cli/src/core/agent-loop.js';
import { DEFAULT_CONFIG, loadConfig } from '../../nhom-30/axiom-cli/src/core/config.js';
import { EventBus } from '../../nhom-30/axiom-cli/src/core/event-bus.js';
import { buildSystemPrompt } from '../../nhom-30/axiom-cli/src/core/prompt.js';
import { registerSecret, redact } from '../../nhom-30/axiom-cli/src/core/secrets.js';
import { SessionManager } from '../../nhom-30/axiom-cli/src/core/session.js';
import type { TokenUsage } from '../../nhom-30/axiom-cli/src/core/types.js';
import { loadCatalog } from '../../nhom-30/axiom-cli/src/llm/catalog/index.js';
import { CostTracker } from '../../nhom-30/axiom-cli/src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../../nhom-30/axiom-cli/src/llm/model-resolver.js';
import type { BaseTool } from '../../nhom-30/axiom-cli/src/tools/base-tool.js';
import { ToolRegistry } from '../../nhom-30/axiom-cli/src/tools/registry.js';
import { buildMsSystemPrompt, createMsTool } from '../integrations/axiom/ms-tool.js';

type Arm = 'A_eight' | 'B_one';
type PackName = 'uc01' | 'medium' | 'refactor' | 'exercism' | 'hard' | 'refactorbench' | 'refactorbench-js';

/** Aider's polyglot benchmark, Python subset: each exercise is one stub file plus its test suite. */
const EXERCISM_DIR = process.env.EXERCISM_DIR ?? '/tmp/polyglot-benchmark/python/exercises/practice';
/** Microsoft RefactorBench (ICLR): multi-hop refactoring tasks across 9 real Python repositories. */
const REFACTORBENCH_DIR = process.env.REFACTORBENCH_DIR ?? '/tmp/RefactorBench';
/** RefactorBench-JS (2026): behavior-preserving JS/React decomposition scored by hidden Vitest suites. */
const REFACTORBENCH_JS_DIR = process.env.REFACTORBENCH_JS_DIR ?? '/tmp/refactor-bench-js';
const RBJS_VITEST_DIR = process.env.RBJS_VITEST_DIR ?? '/tmp/rbjs-vitest';

function buildExercismPack(): Pack {
  const cases: Record<string, CaseSpec> = {};
  if (fs.existsSync(EXERCISM_DIR)) {
    for (const name of fs.readdirSync(EXERCISM_DIR).sort()) {
      const dir = path.join(EXERCISM_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir);
      const testFile = files.find((file) => file.endsWith('_test.py'));
      const stub = files.find((file) => file.endsWith('.py') && !file.endsWith('_test.py'));
      if (!testFile || !stub) continue;
      cases[name] = {
        testFile,
        task: [
          'Implement `' + stub + '` so that `' + testFile + '` passes.',
          '',
          '`' + testFile + '` is the specification: read it, then write the implementation. Do not modify `' +
            testFile +
            '` or any other file. Run `python3 -m pytest -q ' +
            testFile +
            '` and make it green.',
        ].join('\n'),
      };
    }
  }
  return { name: 'exercism', fixtureDir: EXERCISM_DIR, guard: () => [], cases };
}

function buildRefactorBenchPack(): Pack {
  const cases: Record<string, CaseSpec> = {};
  const mappingPath = path.join(REFACTORBENCH_DIR, 'scripts/descriptive_mapping.py');
  if (fs.existsSync(mappingPath)) {
    const raw = fs.readFileSync(mappingPath, 'utf8');
    const re = /['"]\.\.\/tests\/([^/'"]+)\/([^'"]+\.py)['"]\s*:\s*['"]\.\.\/(problems\/[^'"]+\.txt)['"]/g;
    for (const match of raw.matchAll(re)) {
      const repo = match[1]!;
      const testName = match[2]!;
      const taskRel = match[3]!;
      const testFile = path.join(REFACTORBENCH_DIR, 'tests', repo, testName);
      const taskFile = path.join(REFACTORBENCH_DIR, taskRel);
      const repoDir = path.join(REFACTORBENCH_DIR, 'repositories', repo);
      if (!fs.existsSync(testFile) || !fs.existsSync(taskFile) || !fs.existsSync(repoDir)) continue;
      const caseId = `${repo}/${testName.replace(/\.py$/, '')}`;
      cases[caseId] = {
        repoDir,
        unittestFile: testFile,
        task: [
          fs.readFileSync(taskFile, 'utf8').trim(),
          '',
          'Constraints: work strictly inside the repository root, update all affected imports/callers/tests/docs consistently, and verify your changes before finishing.',
        ].join('\n'),
      };
    }
  }
  return { name: 'refactorbench', fixtureDir: path.join(REFACTORBENCH_DIR, 'repositories'), guard: [], cases };
}

function buildRefactorBenchJsPack(): Pack {
  const cases: Record<string, CaseSpec> = {};
  const dataRoot = path.join(REFACTORBENCH_JS_DIR, 'refactoring/data');
  if (fs.existsSync(dataRoot)) {
    for (const name of fs.readdirSync(dataRoot).sort()) {
      const fixtureDir = path.join(dataRoot, name);
      const cfgPath = path.join(fixtureDir, 'refactoring_eval.config.json');
      const srcDir = path.join(fixtureDir, 'src');
      if (!fs.existsSync(cfgPath) || !fs.existsSync(srcDir)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { targetFile?: string; testFile?: string };
      if (!cfg.targetFile || !cfg.testFile) continue;
      if (!fs.existsSync(path.join(srcDir, cfg.targetFile)) || !fs.existsSync(path.join(fixtureDir, cfg.testFile))) continue;
      const aliasTarget = `@/${cfg.targetFile.replace(/\.[cm]?[jt]sx?$/, '')}`;
      cases[name] = {
        repoDir: fixtureDir,
        jsHoldout: { targetFile: cfg.targetFile, testFile: cfg.testFile },
        task: [
          `Decompose and refactor \`src/${cfg.targetFile}\` into smaller, cohesive modules under \`src/\` while preserving all observable behavior.`,
          '',
          'Requirements:',
          `- Extract cohesive helper/sub-modules as new files under \`src/\` (do not leave \`src/${cfg.targetFile}\` monolithic or untouched).`,
          `- Keep \`src/${cfg.targetFile}\`'s public exports intact (preserve entry signatures / re-export moved symbols so imports of \`./src/${cfg.targetFile}\` and \`${aliasTarget}\` continue to resolve identically).`,
          '- `@/` is the project alias for `src/`. Keep existing external package imports intact.',
          '- Verify syntax and module resolution (e.g. `node`/`bun`) before finishing. Do not create or modify test files or install npm packages.',
        ].join('\n'),
      };
    }
  }
  return { name: 'refactorbench-js', fixtureDir: dataRoot, guard: [], cases };
}

const MS_BIN = process.env.MS_BIN ?? '/home/hoang/ms/target/release/ms';
const PYTHON = process.env.PYTHON ?? 'python3';

interface CaseSpec {
  /** What the model is asked to do, verbatim. */
  task: string;
  /** Optional behavioural probe: the issue's expected behaviour, checked outside the agent workspace. */
  probe?: { code: string; expect: string };
  /** Test node ids that must pass afterwards. */
  requiredTests?: string[];
  /** Grading by suite exit code: this file must pass (the suite is the spec). */
  testFile?: string;
  /** Optional per-case repository source directory (for multi-repo packs like RefactorBench). */
  repoDir?: string;
  /** Hidden unittest script run from `<workspace>/_rb_eval` (reads `../<repo-file>`). */
  unittestFile?: string;
  /** Hidden Vitest suite for RefactorBench-JS fixtures. */
  jsHoldout?: { targetFile: string; testFile: string };
}

interface Pack {
  name: PackName;
  fixtureDir: string;
  /** Paths (files or directories) that must be byte-identical afterwards; a function for per-case guards. */
  guard: string[] | ((caseId: string) => string[]);
  /** Test file kept outside the fixture, copied into tests/ only when grading, so it cannot be read or edited. */
  hiddenTests?: string;
  cases: Record<string, CaseSpec>;
}

const MEDIUM_REQUIRED = [
  'tests/test_api_pagination.py::test_pagination_first_page',
  'tests/test_api_pagination.py::test_pagination_second_page',
  'tests/test_export.py::test_csv_export_handles_none_metadata',
  'tests/test_scheduler.py::test_backoff_caps_at_max_delay',
];

const REFACTOR_REQUIRED = [
  'tests/test_slugs_hidden.py::test_shared_helper_exists',
  'tests/test_slugs_hidden.py::test_make_slug_rules',
  'tests/test_slugs_hidden.py::test_no_job_module_keeps_a_private_copy',
  'tests/test_jobs.py::test_every_job_module_is_wired',
];

const HARD_REQUIRED = [
  'tests/test_connectors.py::test_variant_a_decimal_and_utc',
  'tests/test_connectors.py::test_variant_b_hook_and_decimal',
  'tests/test_connectors.py::test_variant_c_cents_conversion',
  'tests/test_connectors.py::test_variant_d_regional_offset',
  'tests/test_idempotency.py::test_cross_tenant_idempotency_keys_do_not_collide',
  'tests/test_idempotency.py::test_failed_event_can_be_retried',
  'tests/test_idempotency.py::test_cache_is_tenant_scoped_copy_safe_and_lru',
  'tests/test_pipeline.py::test_per_tenant_sequence_is_isolated',
  'tests/test_pipeline.py::test_failed_ingest_allows_retry_and_rejects_conflict',
  'tests/test_reconcile.py::test_reconcile_exact_decimal_and_refund_subtraction',
  'tests/test_reconcile.py::test_window_half_open_bounds',
  'tests/test_hard_hidden.py::test_shared_normalize_helper_exists_and_enforces_contract',
  'tests/test_hard_hidden.py::test_all_16_connectors_migrated_and_no_private_copies',
  'tests/test_hard_hidden.py::test_thousand_event_penny_precision_and_replay_strict',
];

const PACKS: Record<PackName, Pack> = {
  get exercism() {
    return buildExercismPack();
  },
  get refactorbench() {
    return buildRefactorBenchPack();
  },
  get 'refactorbench-js'() {
    return buildRefactorBenchJsPack();
  },
  uc01: {
    name: 'uc01',
    fixtureDir: '/home/hoang/nhom-30/axiom-cli/evals/fixtures/uc01',
    guard: ['tests'],
    cases: {
      'uc01-01-bug-crash-null': {
        task: [
          'Fix the following bug in the workspace. Reproduce or verify it, apply the minimal fix, and run tests/checks to confirm.',
          '',
          fs.readFileSync('/home/hoang/nhom-30/axiom-cli/evals/uc01/uc01-01-bug-crash-null.json', 'utf8'),
        ].join('\n'),
        probe: { code: "from tinydb_demo.format import format_tags\nprint(repr(format_tags({'title': 'x'})))", expect: "''" },
      },
      'uc01-02-bug-test-fail': {
        task: [
          'Fix the following bug in the workspace. Reproduce or verify it, apply the minimal fix, and run tests/checks to confirm.',
          '',
          fs.readFileSync('/home/hoang/nhom-30/axiom-cli/evals/uc01/uc01-02-bug-test-fail.json', 'utf8'),
        ].join('\n'),
        probe: {
          code: "import tempfile\nfrom tinydb_demo.store import Store\ns = Store(tempfile.mkdtemp() + '/db.json')\ns.add({'title': 'Hello World'})\nprint(len(s.search('hello')))",
          expect: '1',
        },
      },
      'uc01-03-bug-reproducible': {
        task: [
          'Fix the following bug in the workspace. Reproduce or verify it, apply the minimal fix, and run tests/checks to confirm.',
          '',
          fs.readFileSync('/home/hoang/nhom-30/axiom-cli/evals/uc01/uc01-03-bug-reproducible.json', 'utf8'),
        ].join('\n'),
        probe: { code: 'from tinydb_demo.pretty import render_table\nprint(repr(render_table([])))', expect: "''" },
      },
    },
  },
  medium: {
    name: 'medium',
    fixtureDir: '/home/hoang/ms/benchmarks/fixtures/medium-repo-eval',
    guard: ['tests', 'pytest.ini'],
    cases: {
      'medium-4bugs': {
        requiredTests: MEDIUM_REQUIRED,
        task: [
          'Fix every failing test in this repository, and keep the 120 tests that already pass passing.',
          '',
          '`python3 -m pytest -q` reports:',
          '',
          ...MEDIUM_REQUIRED.map((test) => `FAILED ${test}`),
          '',
          'Known details:',
          '- test_pagination_first_page / test_pagination_second_page: the API returns task ids out of order',
          "  ('t-11' where 't-01' is expected) and the second page repeats the first page's items.",
          "- test_csv_export_handles_none_metadata: taskflow/plugins/csv_export.py raises AttributeError:",
          "  'NoneType' object has no attribute 'get' when a task has metadata None.",
          '- test_backoff_caps_at_max_delay: compute_backoff_ms(1, RetryConfig(max_attempts=5, base_delay_ms=100,\n  max_delay_ms=500, jitter=False)) returns 500, expected 100: the first retry must use base_delay_ms and only\n  later retries may grow, capped at max_delay_ms.',
          '',
          'Constraints: do not edit anything under tests/ or pytest.ini; fix the code under test instead.',
          'Run the suite when done and report what passed.',
        ].join('\n'),
      },
    },
  },
};

interface CliOptions {
  packName: PackName;
  model: string;
  trials: number;
  cases: string[];
  arms?: Arm[];
  maxSteps: number;
  outDir: string;
  /** Aggregate an existing runs.jsonl instead of calling the model again. */
  recompute?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    packName: 'uc01',
    model: 'trollllm/deepseek-v4-1-flash',
    trials: 2,
    cases: Object.keys(PACKS.uc01.cases),
    maxSteps: 25,
    outDir: `/home/hoang/ms/benchmarks/artifacts/single-tool-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
  let casesGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--pack') {
      const name = next();
      if (!(name in PACKS)) throw new Error(`unknown pack: ${name}`);
      opts.packName = name;
      if (!casesGiven) opts.cases = Object.keys(PACKS[name].cases);
    } else if (arg === '--model') opts.model = next();
    else if (arg === '--trials') opts.trials = Number(next());
    else if (arg === '--cases') {
      opts.cases = next().split(',').map((s) => s.trim()).filter(Boolean);
      casesGiven = true;
    } else if (arg === '--arms') {
      opts.arms = next().split(',').map((s) => s.trim()).filter((s): s is Arm => s === 'A_eight' || s === 'B_one');
    } else if (arg === '--max-steps') opts.maxSteps = Number(next());
    else if (arg === '--out') opts.outDir = path.resolve(next());
    else if (arg === '--recompute') opts.recompute = path.resolve(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

PACKS.refactor = {
  name: 'refactor',
  fixtureDir: '/home/hoang/ms/benchmarks/fixtures/refactor-repo',
  guard: ['tests', 'pytest.ini'],
  hiddenTests: '/home/hoang/ms/benchmarks/hidden/test_slugs_hidden.py',
  cases: {
    'refactor-slug-migration': {
      requiredTests: REFACTOR_REQUIRED,
      task: [
        'Unify the slug helper across the code base.',
        '',
        'Every module in taskflow/jobs/ (24 of them) carries its own private copy of `make_slug(title)`.',
        'Replace all 24 copies with one shared helper `taskflow.core.slugs.make_slug` and import it wherever the',
        'copies were used.',
        '',
        'The shared helper must follow these rules exactly:',
        '- lowercase the title;',
        '- replace every run of characters that are not ASCII a-z or 0-9 with a single "-";',
        '- strip leading and trailing "-";',
        '- `make_slug("")` and `make_slug("   ")` return "".',
        '',
        'Behaviour that must not change:',
        '- `label_NN(task)` still returns f"{make_slug(task.title)}-{task.priority}";',
        '- `summary_NN(task)` still returns f"jobNN:{make_slug(task.title)}";',
        '- every other test in the repository keeps passing.',
        '',
        'Constraints: do not edit anything under tests/ or pytest.ini. Run the suite when done and report the counts.',
      ].join('\n'),
    },
  },
};

PACKS.hard = {
  name: 'hard',
  fixtureDir: '/home/hoang/ms/benchmarks/fixtures/hard-repo',
  guard: ['tests', 'pytest.ini', 'scripts'],
  hiddenTests: '/home/hoang/ms/benchmarks/hidden/test_hard_hidden.py',
  cases: {
    'chronos-multistep-gauntlet': {
      requiredTests: HARD_REQUIRED,
      task: [
        'Fix all coupled defects and complete the connector normalization migration in this repository (`chronos`).',
        '',
        '1. Triage both `python3 -m pytest -q` AND `python3 scripts/replay_incidents.py --strict` (warning: the replay emits ~3,600 lines of telemetry with 4 buried `[INCIDENT-XX]` failures).',
        '2. Create `chronos.core.normalize.normalize_event(raw, *, default_currency="USD", amount_is_cents=False, default_tz_offset_hours=0, source="unknown", region="global") -> EventEnvelope`:',
        '   - Parse `amount` (or `amount_cents` when `amount_is_cents=True`) into `Decimal` quantized to `0.01` (`ROUND_HALF_EVEN`), stripping `$`/`,`/whitespace and raising `ValidationError` on empty/non-numeric/non-finite values;',
        '   - Parse `occurred_at` into UTC-aware `datetime` (applying `default_tz_offset_hours` if naive);',
        '   - Validate non-empty `event_id` and `tenant_id` (falling back to legacy `tenant`); copy `metadata` (dict or `{}`).',
        '3. Migrate ALL 16 heterogeneous connectors (`chronos/connectors/conn_01.py`..`conn_12.py` and `chronos/connectors/regional/conn_13.py`..`conn_16.py`) to delegate to `normalize_event`, removing every private `def _clean_amount` and `def _parse_ts` while preserving each variant public signature, hooks (`ConnectorNN`), cents handling, and regional offset.',
        '4. Fix all coupled pipeline & storage defects across `chronos/core/schema.py`, `chronos/storage/cache.py` (tenant-scoped key, defensive copy, true LRU), `chronos/storage/idempotency.py` (tenant-scoped, payload mismatch -> `IdempotencyConflictError`, failed -> retryable), `chronos/engine/window.py` (half-open `[start, end)`), `chronos/engine/reconcile.py` (`Decimal`, subtract `refund`, handle `None` metadata/tags), and `chronos/engine/pipeline.py` (read the entire file past line 200: per-tenant sequence tracking and `mark_failed` on exception).',
        '5. Keep `chronos/legacy/v1_compat.py` and all 82 baseline passing tests working.',
        '',
        'Constraints: do not edit anything under `tests/`, `pytest.ini`, or `scripts/`. Both `python3 -m pytest -q` and `python3 scripts/replay_incidents.py --strict` must pass with exit code 0.',
      ].join('\n'),
    },
  },
};

interface PytestReport {
  exitCode: number | null;
  failed: string[];
  passed: string[];
  collectionError: boolean;
  summary: string;
}

function runPytest(workspace: string): PytestReport {
  const result = spawnSync(PYTHON, ['-m', 'pytest', '-q', '--tb=no', '-rA', '-p', 'no:cacheprovider'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const lines = output.split('\n');
  return {
    exitCode: result.status,
    failed: lines.filter((line) => line.startsWith('FAILED ')).map((line) => line.slice(7).split(' ')[0]!),
    passed: lines.filter((line) => line.startsWith('PASSED ')).map((line) => line.slice(7).split(' ')[0]!),
    collectionError: /errors? during collection|ERROR tests\//.test(output),
    summary: output.trim().split('\n').slice(-1)[0] ?? '',
  };
}

function runProbe(workspace: string, probe: { code: string; expect: string }): { ok: boolean; output: string } {
  const result = spawnSync(PYTHON, ['-c', probe.code], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0 && output === probe.expect, output: output.slice(0, 400) };
}

/** Per-file digests, so a new test file is not mistaken for a weakened one. */
function snapshotFiles(target: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(target)) return files;
  const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fs.statSync(target).isFile()) {
    files.set(path.basename(target), digest(target));
    return files;
  }
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      // pytest rewrites __pycache__ in tests/; that is not the agent touching a test.
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__') walk(full);
      } else if (!entry.name.endsWith('.pyc')) {
        files.set(path.relative(target, full), digest(full));
      }
    }
  };
  walk(target);
  return files;
}

function runUnittestHidden(workspace: string, unittestFile: string): PytestReport {
  const evalDir = path.join(workspace, '_rb_eval');
  fs.mkdirSync(evalDir, { recursive: true });
  const target = path.join(evalDir, path.basename(unittestFile));
  fs.copyFileSync(unittestFile, target);
  const result = spawnSync(PYTHON, ['-m', 'unittest', path.basename(unittestFile)], {
    cwd: evalDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ranMatch = /Ran (\d+) tests?/.exec(output);
  const total = ranMatch ? Number(ranMatch[1]) : 0;
  const ok = result.status === 0 && total > 0;
  return {
    exitCode: result.status,
    failed: ok ? [] : [path.basename(unittestFile)],
    passed: ok ? [path.basename(unittestFile)] : [],
    collectionError: !ranMatch && result.status !== 0,
    summary: output.trim().split('\n').slice(-1)[0] ?? '',
  };
}

function listFilesUnder(dir: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(dir)) return out;
  const walk = (cur: string) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.add(path.relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

function runVitestHidden(
  workspace: string,
  repoDir: string,
  jsHoldout: { targetFile: string; testFile: string },
  srcBefore: Set<string>,
): PytestReport & { nonTrivial: boolean } {
  const srcAfter = listFilesUnder(path.join(workspace, 'src'));
  const addedFiles = [...srcAfter].filter((f) => !srcBefore.has(f));
  const nonTrivial = addedFiles.length > 0;
  const holdoutDest = path.join(workspace, jsHoldout.testFile);
  fs.mkdirSync(path.dirname(holdoutDest), { recursive: true });
  fs.copyFileSync(path.join(repoDir, jsHoldout.testFile), holdoutDest);
  const nmLink = path.join(workspace, 'node_modules');
  if (!fs.existsSync(nmLink)) fs.symlinkSync(path.join(RBJS_VITEST_DIR, 'node_modules'), nmLink);

  const vitestBin = path.join(RBJS_VITEST_DIR, 'node_modules/.bin/vitest');
  const vitestCfg = path.join(RBJS_VITEST_DIR, 'vitest.config.mjs');
  const result = spawnSync(vitestBin, ['run', '--config', vitestCfg, jsHoldout.testFile], {
    cwd: workspace,
    env: { ...process.env, RBJS_WORKSPACE: workspace, RBJS_TEST_FILE: jsHoldout.testFile },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const passedMatch = /(\d+)\s+passed/.exec(clean);
  const failedMatch = /(\d+)\s+failed/.exec(clean);
  const passedCount = passedMatch ? Number(passedMatch[1]) : 0;
  const failedCount = failedMatch ? Number(failedMatch[1]) : 0;
  const ok = result.status === 0 && passedCount > 0 && failedCount === 0;
  const line =
    clean
      .split('\n')
      .find((l) => /\bTests\s+/.test(l))
      ?.trim() ||
    clean.trim().split('\n').slice(-2).join(' | ');
  return {
    exitCode: result.status,
    failed: ok && nonTrivial ? [] : [jsHoldout.testFile],
    passed: ok && nonTrivial ? [jsHoldout.testFile] : [],
    collectionError: passedCount === 0 && result.status !== 0,
    summary: `nonTrivial=${nonTrivial} (+${addedFiles.length} files) | ${line}`.slice(0, 240),
    nonTrivial,
  };
}

/** One exercise is its own workspace: the pack's fixture dir holds a directory per case. */
function workspaceFor(pack: Pack, caseId: string): string {
  const spec = pack.cases[caseId];
  if (spec?.repoDir) return spec.repoDir;
  const candidate = path.join(pack.fixtureDir, caseId);
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : pack.fixtureDir;
}

function guardSnapshot(workspace: string, guard: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of guard) {
    for (const [file, hash] of snapshotFiles(path.join(workspace, entry))) files.set(`${entry}/${file}`, hash);
  }
  return files;
}

function buildRegistry(arm: Arm, workspace: string, stateDir: string): { registry: ToolRegistry; close: () => Promise<void> } {
  if (arm === 'A_eight') {
    const registry = new ToolRegistry();
    registry.allowWithoutApprover = true;
    return { registry, close: async () => {} };
  }
  const registry = new ToolRegistry(['ms']);
  registry.allowWithoutApprover = true;
  const tool = createMsTool({
    msBin: MS_BIN,
    workspaceRoot: workspace,
    stateDir,
    allowWrite: true,
    allowUnapprovedWrites: true,
    limits: { timeoutMs: 900_000, maxCalls: 512 },
  });
  registry.registerTool(tool as unknown as BaseTool);
  return { registry, close: () => tool.close() };
}

interface RunRecord {
  pack: PackName;
  arm: Arm;
  caseId: string;
  trial: number;
  pairOrder: 'AB' | 'BA';
  agentStatus: string;
  targetFixed: boolean;
  probeOutput: string;
  requiredTestsPassed: number;
  requiredTestsTotal: number;
  noRegressions: boolean;
  newFailures: string[];
  collectionError: boolean;
  testsIntact: boolean;
  tamperedTestFiles: string[];
  overallPassed: boolean;
  llmTurns: number;
  toolCalls: number;
  toolFailures: number;
  toolOutputBytes: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
  estimatedCostUsd?: number | null;
  wallClockMs: number;
  toolErrorSamples?: string[];
  error?: string;
}

const PRICING_PER_1M: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5.5': { input: 0.10, output: 0.50, cacheRead: 0.02, cacheWrite: 0.125 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
};

function estimateUsd(model: string, input: number, cacheRead: number, cacheWrite: number, output: number): number | null {
  const bare = model.toLowerCase().split('/').pop() ?? '';
  const key = bare.replace('claude-haiku-5-5', 'claude-haiku-5.5');
  const p = PRICING_PER_1M[key];
  if (!p) return null;
  return Number((((input * p.input) + (cacheRead * p.cacheRead) + (cacheWrite * p.cacheWrite) + (output * p.output)) / 1_000_000).toFixed(6));
}

interface ToolTrace {
  seq: number;
  turn: number;
  name: string;
  isError: boolean;
  outputBytes: number;
  argsPreview: string;
  outputPreview: string;
}

async function runOnce(
  options: CliOptions,
  pack: Pack,
  arm: Arm,
  caseId: string,
  trial: number,
  pairOrder: 'AB' | 'BA',
  baseline: PytestReport,
): Promise<RunRecord> {
  const safeCaseId = caseId.replaceAll('/', '__');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ab1-${arm}-${safeCaseId}-`));
  const workspace = path.join(tmpRoot, 'workspace');
  const stateDir = path.join(tmpRoot, 'ms-state');
  const spec = pack.cases[caseId]!;
  if (spec.jsHoldout) {
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(path.join(workspaceFor(pack, caseId), 'src'), path.join(workspace, 'src'), { recursive: true });
  } else {
    fs.cpSync(workspaceFor(pack, caseId), workspace, { recursive: true });
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const srcBefore = spec.jsHoldout ? listFilesUnder(path.join(workspace, 'src')) : new Set<string>();
  const guard = typeof pack.guard === 'function' ? pack.guard(caseId) : pack.guard;
  const guardBefore = guardSnapshot(workspace, guard);

  const started = performance.now();
  const { registry, close } = buildRegistry(arm, workspace, stateDir);
  let llmTurns = 0;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, costEstimate: 0 };
  const bus = new EventBus();
  let toolCalls = 0;
  let toolFailures = 0;
  let toolOutputBytes = 0;
  const toolErrorSamples: string[] = [];
  const toolTraces: ToolTrace[] = [];
  const pendingArgs = new Map<string, { name: string; args: unknown }>();
  bus.on('cost_update', (u: TokenUsage) => {
    llmTurns++;
    usage.promptTokens += u.promptTokens ?? 0;
    usage.completionTokens += u.completionTokens ?? 0;
    usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
    usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    usage.totalTokens += u.totalTokens ?? 0;
  });
  bus.on('tool_call_start', (tc: { id: string; name: string; arguments: unknown }) => {
    pendingArgs.set(tc.id, { name: tc.name, args: tc.arguments });
  });
  bus.on('tool_call_end', (result: { toolCallId?: string; name?: string; output: string; isError?: boolean }) => {
    toolCalls++;
    const outputStr = String(result.output ?? '');
    const bytes = Buffer.byteLength(outputStr, 'utf8');
    toolOutputBytes += bytes;
    const isErr = result.isError === true;
    const startMeta = result.toolCallId ? pendingArgs.get(result.toolCallId) : undefined;
    if (result.toolCallId) pendingArgs.delete(result.toolCallId);
    const toolName = result.name ?? startMeta?.name ?? 'unknown';
    if (isErr) {
      toolFailures++;
      if (toolErrorSamples.length < 10) toolErrorSamples.push(redact(`${toolName}: ${outputStr.slice(0, 240)}`));
    }
    toolTraces.push({
      seq: toolCalls,
      turn: llmTurns,
      name: toolName,
      isError: isErr,
      outputBytes: bytes,
      argsPreview: redact(JSON.stringify(startMeta?.args ?? null) ?? '').slice(0, 600),
      outputPreview: redact(outputStr.slice(0, 600)),
    });
  });

  let agentStatus = 'ok';
  let error: string | undefined;
  let assistantTurns: Array<{ turn: number; toolCalls: number; text: string }> = [];
  try {
    const config = loadConfig();
    const catalog = loadCatalog();
    const modelInfo = (() => {
      try {
        return resolveModel(options.model, catalog, config);
      } catch (err) {
        const slash = options.model.indexOf('/');
        if (slash <= 0) throw err;
        const prov = options.model.slice(0, slash);
        const customId = options.model.slice(slash + 1);
        const firstForProv = catalog.models(prov)[0];
        if (!firstForProv) throw err;
        return { ...resolveModel(`${prov}/${firstForProv.id}`, catalog, config), id: customId, name: customId };
      }
    })();
    const rawProvider = await createProviderFor(modelInfo);
    const turnDiagnostics: Array<{
      turn: number;
      completionTokens: number;
      thinkingChars: number;
      thinkingTail: string;
      textChars: number;
      toolCalls: number;
      finishReason?: string;
    }> = [];
    const provider = Object.assign(Object.create(Object.getPrototypeOf(rawProvider)), rawProvider, {
      chat: async (chatParams: Parameters<typeof rawProvider.chat>[0]) => {
        let thinking = '';
        const res = await rawProvider.chat({
          ...chatParams,
          onThinking: (d: string) => {
            thinking += d;
            chatParams.onThinking?.(d);
          },
        });
        turnDiagnostics.push({
          turn: turnDiagnostics.length + 1,
          completionTokens: res.usage?.completionTokens ?? 0,
          thinkingChars: thinking.length,
          thinkingTail: redact(thinking.slice(-1200)),
          textChars: (res.content ?? '').length,
          toolCalls: res.toolCalls?.length ?? 0,
          ...(res.finishReason ? { finishReason: res.finishReason } : {}),
        });
        return res;
      },
    });
    const baseSys = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, workspace);
    const armSys = arm === 'B_one' ? buildMsSystemPrompt(baseSys) : baseSys;
    const envBlock = spec.jsHoldout
      ? [
          'Environment:',
          `- Workspace root: ${workspace}`,
          '- Use relative paths from the workspace root for project files.',
          '- JS/JSX verification: `node` and `bun` are installed, while `node_modules` is absent (do not install packages or run `bun build` without `--external`). To syntax-check `.js`/`.jsx` cleanly in one pass without creating repo scratch files, run `bun -e` using `new Bun.Transpiler({ loader: f.endsWith(".jsx") ? "jsx" : "js" }).transformSync(...)` or `node --check` on pure non-JSX modules.',
        ].join('\n')
      : [
          'Environment:',
          `- Workspace root: ${workspace}`,
          '- Use relative paths from the workspace root for project files.',
          '- Python: use `python3` (`python` is not installed).',
          '- Verification: start with fast syntax/import checks (`python3 -m py_compile ...`, targeted `python3 -c "import ..."`) and runnable local tests; if an external suite fails due to missing optional packages, do not spend turns creating virtualenvs or installing packages via `pip`/`uv`.',
        ].join('\n');
    const loop = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: workspace },
      provider,
      model: modelInfo.id,
      toolRegistry: registry,
      sessionManager: new SessionManager({ workspaceRoot: workspace, sessionsDir: path.join(tmpRoot, 'sessions'), autoSave: false }),
      costTracker: new CostTracker(),
      eventBus: bus,
      systemPrompt: `${armSys}\n\n${envBlock}`,
      maxTokens: modelInfo.maxTokens ?? 32768,
      maxSteps: options.maxSteps,
      budgetLimitDollars: 10,
    });
    const task = await loop.runTask(spec.task);
    let aIdx = 0;
    assistantTurns = loop
      .transcript()
      .filter((m) => m.role === 'assistant')
      .map((m) => {
        const diag = turnDiagnostics[aIdx];
        return {
          turn: ++aIdx,
          toolCalls: m.toolCalls?.length ?? 0,
          text: redact(String(m.content ?? '')).slice(0, 4000),
          ...(diag ?? {}),
        };
      });
    agentStatus = task.status === 'completed' ? 'ok' : /timeout|abort/i.test(String(task.error ?? '')) ? 'timeout' : 'error';
    if (task.error) error = redact(task.error);
  } catch (caught) {
    agentStatus = 'error';
    error = redact(caught instanceof Error ? caught.message : String(caught));
  } finally {
    await close();
  }

  // Hidden tests land only now: they were never inside the workspace while the agent worked.
  if (pack.hiddenTests) fs.copyFileSync(pack.hiddenTests, path.join(workspace, 'tests', path.basename(pack.hiddenTests)));
  const probe = spec.probe ? runProbe(workspace, spec.probe) : undefined;
  const post = spec.jsHoldout
    ? runVitestHidden(workspace, spec.repoDir!, spec.jsHoldout, srcBefore)
    : spec.unittestFile
      ? runUnittestHidden(workspace, spec.unittestFile)
      : runPytest(workspace);
  const guardAfter = guardSnapshot(workspace, guard);
  // A guarded file that existed before must be byte-identical afterwards: new files are fine, weakened ones are not.
  const tampered = [...guardBefore].filter(([file, digest]) => guardAfter.get(file) !== digest).map(([file]) => file);
  const newFailures = spec.testFile || spec.unittestFile || spec.jsHoldout ? [] : post.failed.filter((test) => !baseline.failed.includes(test));
  const requiredTests = spec.requiredTests ?? [];
  const requiredPassed = requiredTests.filter(
    (test) => post.passed.some((passed) => passed === test || passed.startsWith(`${test}[`)),
  ).length;
  // Suite mode: the exercise's own tests are the spec, so a green exit code is the fix.
  const suitePassed = spec.testFile || spec.unittestFile || spec.jsHoldout ? post.exitCode === 0 && post.passed.length > 0 : true;
  const targetFixed = (probe?.ok ?? true) && suitePassed && requiredPassed === requiredTests.length;
  const record: RunRecord = {
    pack: pack.name,
    arm,
    caseId,
    trial,
    pairOrder,
    agentStatus,
    targetFixed,
    probeOutput: probe
      ? probe.ok
        ? 'ok'
        : probe.output
      : spec.testFile
        ? `${post.passed.length} passed, ${post.failed.length} failed`
        : spec.unittestFile || spec.jsHoldout
          ? post.summary
          : `${requiredPassed}/${requiredTests.length} required tests`,
    requiredTestsPassed: requiredPassed,
    requiredTestsTotal: requiredTests.length,
    noRegressions: newFailures.length === 0 && !post.collectionError,
    newFailures,
    collectionError: post.collectionError,
    testsIntact: tampered.length === 0,
    tamperedTestFiles: tampered,
    overallPassed: targetFixed && newFailures.length === 0 && !post.collectionError && tampered.length === 0 && agentStatus === 'ok',
    llmTurns,
    toolCalls,
    toolFailures,
    toolOutputBytes,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
    cacheHitRate: (() => {
      const cacheRead = usage.cacheReadInputTokens ?? 0;
      const cacheWrite = usage.cacheCreationInputTokens ?? 0;
      const denom = usage.promptTokens + cacheRead + cacheWrite;
      return denom > 0 ? Number((cacheRead / denom).toFixed(4)) : 0;
    })(),
    estimatedCostUsd: estimateUsd(
      options.model,
      usage.promptTokens,
      usage.cacheReadInputTokens ?? 0,
      usage.cacheCreationInputTokens ?? 0,
      usage.completionTokens,
    ),
    wallClockMs: Number((performance.now() - started).toFixed(1)),
    ...(toolErrorSamples.length ? { toolErrorSamples } : {}),
    ...(error ? { error } : {}),
  };
  const tracesDir = path.join(options.outDir, 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tracesDir, `${arm}__${safeCaseId}__t${trial}.json`),
    `${JSON.stringify({ pack: pack.name, arm, caseId, trial, overallPassed: record.overallPassed, probeOutput: record.probeOutput, assistantTurns, toolTraces }, null, 2)}\n`,
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return record;
}

/** Re-applies the current integrity rule to stored records, so a fixed oracle does not need new model calls. */
function normalise(records: RunRecord[]): RunRecord[] {
  return records.map((record) => {
    const tampered = record.tamperedTestFiles.filter((file) => !file.endsWith('.pyc') && !file.includes('__pycache__'));
    return {
      ...record,
      tamperedTestFiles: tampered,
      testsIntact: tampered.length === 0,
      overallPassed:
        record.targetFixed && record.newFailures.length === 0 && !record.collectionError && tampered.length === 0 && record.agentStatus === 'ok',
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.recompute) {
    const dir = options.recompute;
    const records = normalise(
      fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunRecord),
    );
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as {
      baseline: PytestReport;
      options: CliOptions;
    };
    report(records, { ...stored.options, recompute: dir }, stored.baseline, dir);
    return;
  }
  if (process.env.TROLLLLM_API_KEY) registerSecret(process.env.TROLLLLM_API_KEY);
  if (!fs.existsSync(MS_BIN)) throw new Error(`ms binary missing: ${MS_BIN}`);
  const pack = PACKS[options.packName];
  fs.mkdirSync(options.outDir, { recursive: true });
  const jsonlPath = path.join(options.outDir, 'runs.jsonl');

  // Per-case suites (exercism, refactorbench, refactorbench-js) have no meaningful suite-wide baseline.
  const perCase = Object.values(pack.cases).some((spec) => spec.testFile !== undefined || spec.unittestFile !== undefined || spec.jsHoldout !== undefined);
  let baseline: PytestReport = { exitCode: 0, failed: [], passed: [], collectionError: false, summary: 'per-case suites' };
  if (!perCase) {
    const pristine = fs.mkdtempSync(path.join(os.tmpdir(), 'ab1-baseline-'));
    fs.cpSync(pack.fixtureDir, pristine, { recursive: true });
    baseline = runPytest(pristine);
    fs.rmSync(pristine, { recursive: true, force: true });
  }
  console.log(
    `pack ${pack.name} · baseline: ${baseline.passed.length} passed, ${baseline.failed.length} failed [${baseline.failed.join(', ')}]`,
  );
  console.log(`model: ${options.model} · trials: ${options.trials} · cases: ${options.cases.length} · max steps: ${options.maxSteps}\n`);

  const records: RunRecord[] = [];
  for (let trial = 0; trial < options.trials; trial++) {
    const pairOrder: 'AB' | 'BA' = trial % 2 === 0 ? 'AB' : 'BA';
    const baseOrder: Arm[] = pairOrder === 'AB' ? ['A_eight', 'B_one'] : ['B_one', 'A_eight'];
    const order = options.arms?.length ? baseOrder.filter((a) => options.arms!.includes(a)) : baseOrder;
    for (const caseId of options.cases) {
      for (const arm of order) {
        const record = await runOnce(options, pack, arm, caseId, trial, pairOrder, baseline);
        records.push(record);
        fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
        const fix = record.requiredTestsTotal ? ` (${record.requiredTestsPassed}/${record.requiredTestsTotal} required)` : '';
        const cacheInfo = record.cacheHitRate !== undefined ? ` cache=${(record.cacheHitRate * 100).toFixed(1)}%` : '';
        const costInfo = record.estimatedCostUsd != null ? ` $${record.estimatedCostUsd.toFixed(4)}` : '';
        console.log(
          `${record.overallPassed ? 'PASS' : 'fail'}${fix} ${arm.padEnd(7)} ${caseId} t${trial} · turns=${record.llmTurns} tools=${record.toolCalls} bytes=${record.toolOutputBytes} tok=${record.promptTokens}+${record.completionTokens} (cr=${record.cachedTokens},cw=${record.cacheWriteTokens ?? 0}${cacheInfo}${costInfo}) ${Math.round(record.wallClockMs / 1000)}s`,
        );
      }
    }
  }
  report(records, options, baseline, options.outDir);
}

function report(records: RunRecord[], options: CliOptions, baseline: PytestReport, outDir: string): void {
  const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : Number(((sorted[mid - 1]! + sorted[mid]!) / 2).toFixed(1));
  };
  const summarize = (arm: Arm) => {
    const runs = records.filter((record) => record.arm === arm);
    return {
      runs: runs.length,
      passed: runs.filter((record) => record.overallPassed).length,
      targetFixed: runs.filter((record) => record.targetFixed).length,
      requiredTests: runs.reduce((sum, record) => sum + record.requiredTestsPassed, 0),
      regressions: runs.filter((record) => !record.noRegressions).length,
      testTampering: runs.filter((record) => !record.testsIntact).length,
      errors: runs.filter((record) => record.agentStatus !== 'ok').length,
      toolFailures: runs.reduce((sum, record) => sum + record.toolFailures, 0),
      medianTurns: median(runs.map((record) => record.llmTurns)),
      medianToolCalls: median(runs.map((record) => record.toolCalls)),
      medianOutputBytes: median(runs.map((record) => record.toolOutputBytes)),
      totalTokens: runs.reduce((sum, record) => sum + record.promptTokens + record.completionTokens, 0),
      medianWallClockMs: median(runs.map((record) => record.wallClockMs)),
    };
  };

  const summary = { schemaVersion: '1.1.0', options, baseline, arms: { A_eight: summarize('A_eight'), B_one: summarize('B_one') }, records };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\narm      runs pass fix req regress tamper err  medTurns medTools medBytes  tokens    medWall');
  for (const arm of ['A_eight', 'B_one'] as const) {
    const s = summary.arms[arm];
    console.log(
      `${arm.padEnd(8)} ${String(s.runs).padStart(4)} ${String(s.passed).padStart(4)} ${String(s.targetFixed).padStart(3)} ${String(s.requiredTests).padStart(3)} ${String(s.regressions).padStart(7)} ${String(s.testTampering).padStart(6)} ${String(s.errors).padStart(3)} ${String(s.medianTurns).padStart(8)} ${String(s.medianToolCalls).padStart(8)} ${String(s.medianOutputBytes).padStart(8)} ${String(s.totalTokens).padStart(8)} ${String(s.medianWallClockMs).padStart(8)}`,
    );
  }

  for (const caseId of options.cases) {
    const pair = (arm: Arm) => records.filter((record) => record.caseId === caseId && record.arm === arm);
    const a = pair('A_eight');
    const b = pair('B_one');
    if (!a.length || !b.length) continue;
    const mean = (runs: RunRecord[], pick: (record: RunRecord) => number) => runs.reduce((sum, record) => sum + pick(record), 0) / runs.length;
    const delta = (pick: (record: RunRecord) => number) => {
      const before = mean(a, pick);
      return before === 0 ? 0 : ((mean(b, pick) - before) / before) * 100;
    };
    console.log(
      `${caseId}: turns ${delta((r) => r.llmTurns).toFixed(1)}% · tools ${delta((r) => r.toolCalls).toFixed(1)}% · bytes ${delta((r) => r.toolOutputBytes).toFixed(1)}% · tokens ${delta((r) => r.promptTokens + r.completionTokens).toFixed(1)}% · wall ${delta((r) => r.wallClockMs).toFixed(1)}%`,
    );
  }
  const pairedPct = (pick: (r: RunRecord) => number) => {
    const byPair = new Map<string, { A?: RunRecord; B?: RunRecord }>();
    for (const r of records) {
      const k = `${r.caseId}::${r.trial}`;
      const cur = byPair.get(k) ?? {};
      if (r.arm === 'A_eight') cur.A = r;
      else cur.B = r;
      byPair.set(k, cur);
    }
    const ds: number[] = [];
    for (const p of byPair.values()) {
      if (!p.A || !p.B) continue;
      const a = pick(p.A);
      if (a > 0) ds.push(((pick(p.B) - a) / a) * 100);
    }
    return median(ds).toFixed(1);
  };
  if (records.length > 2) {
    console.log(
      `paired-median: turns ${pairedPct((r) => r.llmTurns)}% · tools ${pairedPct((r) => r.toolCalls)}% · bytes ${pairedPct((r) => r.toolOutputBytes)}% · prompt ${pairedPct((r) => r.promptTokens)}% · wall ${pairedPct((r) => r.wallClockMs)}%`,
    );
  }
  console.log(`\nartifacts: ${outDir}`);
}

await main();
