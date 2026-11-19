import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pythonBin } from '../../nhom-30/axiom-cli/src/core/paths.js';
import { scrubEnv } from '../../nhom-30/axiom-cli/src/core/secrets.js';
import { parsePytestReport } from '../../nhom-30/axiom-cli/src/core/verifier.js';
import { findChangeTampering, isTestPath } from '../examples/axiom_adapter.js';

export type AgentStatus = 'ok' | 'timeout' | 'error';

export interface PytestSnapshot {
  passed: string[];
  failed: string[];
  skipped: string[];
  errors: string[];
  complete: boolean;
  timedOut: boolean;
  exitCode: number | null;
  summary: string;
}

export interface TestIntegrityResult {
  ok: boolean;
  tamperingReasons: string[];
  modifiedExistingTestFiles: string[];
  addedTestFiles: string[];
}

export interface IndependentVerification {
  /** Overall verdict: true ONLY when targetFixed && noRegressions && verificationComplete && agentStatus === 'ok'. */
  passed: boolean;
  overallPassed: boolean;
  targetFixed: boolean;
  noRegressions: boolean;
  verificationComplete: boolean;
  agentStatus: AgentStatus;
  details: string;
  regressionReasons: string[];
  invariantErrors: string[];
  testIntegrity: TestIntegrityResult;
  pytestExitCode: number | null;
  pytestSummary: string;
  pytest: PytestSnapshot;
}

const PLUGIN_MODULE = 'ab_axiom_pytest_report';
const PLUGIN_SOURCE = `import json, os

_PATH = os.environ["AB_AXIOM_PYTEST_REPORT"]

def _emit(record):
    with open(_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\\n")

def pytest_collectreport(report):
    if report.failed:
        _emit({"kind": "collect", "nodeid": report.nodeid or "<session>"})

def pytest_runtest_logreport(report):
    if report.when != "call" and report.passed:
        return
    outcome = report.outcome
    if hasattr(report, "wasxfail"):
        outcome = "skipped" if report.skipped else outcome
    elif report.when != "call" and report.failed:
        outcome = "failed"
    _emit({"kind": "test", "nodeid": report.nodeid, "outcome": outcome})

def pytest_sessionfinish(session, exitstatus):
    _emit({"kind": "session", "exitstatus": int(exitstatus)})
`;

export function runExternalPytest(workspaceDir: string, timeoutMs = 15_000): PytestSnapshot {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pytest-oracle-'));
  try {
    fs.writeFileSync(path.join(scratch, `${PLUGIN_MODULE}.py`), PLUGIN_SOURCE, 'utf8');
    const reportPath = path.join(scratch, 'report.jsonl');
    const python = pythonBin();
    const existingPyPath = process.env.PYTHONPATH ? `${scratch}${path.delimiter}${process.env.PYTHONPATH}` : scratch;
    const res = spawnSync(
      python,
      ['-m', 'pytest', '-q', '-rA', '-p', 'no:cacheprovider', '-o', 'addopts=', '-p', PLUGIN_MODULE],
      {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...scrubEnv(process.env),
          PYTHONPATH: existingPyPath,
          PYTHONDONTWRITEBYTECODE: '1',
          AB_AXIOM_PYTEST_REPORT: reportPath,
        },
      },
    );

    const timedOut = res.error?.name === 'Error' && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const parsed = parsePytestReport(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '');
    const combined = ((res.stdout ?? '') + '\n' + (res.stderr ?? '')).trim();
    const summary = combined ? combined.split('\n').slice(-3).join(' | ') : '(no pytest output)';

    return {
      ...parsed,
      timedOut,
      exitCode: res.status,
      summary,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function captureBaselinePytest(fixtureDir: string, timeoutMs = 15_000): PytestSnapshot {
  const tmpCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-baseline-pytest-'));
  try {
    fs.cpSync(fixtureDir, tmpCopy, { recursive: true });
    return runExternalPytest(tmpCopy, timeoutMs);
  } finally {
    fs.rmSync(tmpCopy, { recursive: true, force: true });
  }
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function isTestConfigRel(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return /^(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/.test(base);
}

export function checkTestIntegrity(fixtureDir: string | undefined, workspaceDir: string): TestIntegrityResult {
  if (!fixtureDir || !fs.existsSync(fixtureDir)) {
    return { ok: true, tamperingReasons: [], modifiedExistingTestFiles: [], addedTestFiles: [] };
  }

  const baseFiles = listFilesRecursive(fixtureDir);
  const workFiles = listFilesRecursive(workspaceDir);
  const baseSet = new Set(baseFiles);
  const workSet = new Set(workFiles);

  const tamperingReasons: string[] = [];
  const modifiedExistingTestFiles: string[] = [];
  const addedTestFiles: string[] = [];

  for (const rel of baseFiles) {
    if (!isTestPath(rel) && !isTestConfigRel(rel)) continue;
    const before = fs.readFileSync(path.join(fixtureDir, rel), 'utf8');
    if (!workSet.has(rel)) {
      tamperingReasons.push(`Existing test/config file deleted: ${rel}`);
      modifiedExistingTestFiles.push(rel);
      continue;
    }
    const after = fs.readFileSync(path.join(workspaceDir, rel), 'utf8');
    if (before !== after) {
      modifiedExistingTestFiles.push(rel);
      const tamper = findChangeTampering(rel, before, after, workspaceDir);
      if (tamper) {
        tamperingReasons.push(tamper);
      }
    }
  }

  for (const rel of workFiles) {
    if (!baseSet.has(rel) && (isTestPath(rel) || isTestConfigRel(rel))) {
      addedTestFiles.push(rel);
    }
  }

  return {
    ok: tamperingReasons.length === 0,
    tamperingReasons,
    modifiedExistingTestFiles,
    addedTestFiles,
  };
}

export function checkHealthyInvariants(workspaceDir: string): { ok: boolean; complete: boolean; errors: string[] } {
  const python = pythonBin();
  const reproDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-invariants-'));
  try {
    const script = [
      'import json, pathlib, sys',
      'from tinydb_demo.store import Store',
      'from tinydb_demo.format import format_tags',
      'from tinydb_demo.pretty import render_table',
      `db_path = pathlib.Path(${JSON.stringify(reproDir)}) / "inv_db.json"`,
      's = Store(db_path)',
      "s.add({'title': 'Alpha Beta', 'tags': ['b', 'a']})",
      "assert len(s.search('Alpha')) == 1, 'exact-case search failed'",
      "assert len(s.search('missing')) == 0, 'non-matching search returned results'",
      's.save()',
      's2 = Store(db_path)',
      "assert len(s2.notes) == 1 and s2.notes[0]['title'] == 'Alpha Beta', 'add/save/reload failed'",
      "assert format_tags({'title': 'a', 'tags': ['z', 'a']}) == 'a, z', 'existing format_tags failed'",
      "assert render_table([{'a': 1, 'bb': 2}, {'a': 3, 'bb': 4}]) == 'a  bb', 'multi-row render_table failed'",
    ].join('\n');

    const res = spawnSync(python, ['-c', script], {
      cwd: reproDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...scrubEnv(process.env),
        PYTHONPATH: workspaceDir,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    const timedOut = res.error?.name === 'Error' && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    if (timedOut || res.status === null) {
      return {
        ok: false,
        complete: false,
        errors: [`Healthy invariants check did not complete (timedOut=${timedOut})`],
      };
    }
    if (res.status !== 0) {
      return {
        ok: false,
        complete: true,
        errors: [`Healthy invariants failed (exit=${res.status}): ${(res.stderr || res.stdout || '').trim()}`],
      };
    }
    return { ok: true, complete: true, errors: [] };
  } finally {
    fs.rmSync(reproDir, { recursive: true, force: true });
  }
}

export function checkTargetBug(
  caseId: string,
  workspaceDir: string,
  afterPytest: PytestSnapshot,
): { fixed: boolean; complete: boolean; details: string } {
  const python = pythonBin();

  if (caseId === 'uc01-01-bug-crash-null') {
    const reproDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-verify-uc01-01-'));
    try {
      fs.writeFileSync(path.join(reproDir, 'notes.json'), JSON.stringify([{ title: 'hello', body: 'x' }]));
      const env = { ...scrubEnv(process.env), PYTHONPATH: workspaceDir, PYTHONDONTWRITEBYTECODE: '1' };
      const cli = spawnSync(python, ['-m', 'tinydb_demo', 'list', '--format', 'tags'], {
        cwd: reproDir,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const unit = spawnSync(
        python,
        [
          '-c',
          [
            'from tinydb_demo.format import format_tags',
            "assert format_tags({'title': 'a'}) == ''",
            "assert format_tags({'title': 'a', 'tags': []}) == ''",
            "assert format_tags({'title': 'a', 'tags': ['z', 'a']}) == 'a, z'",
          ].join('; '),
        ],
        { cwd: workspaceDir, env, encoding: 'utf8', timeout: 10_000 },
      );
      const complete = cli.status !== null && unit.status !== null;
      const fixed = cli.status === 0 && unit.status === 0;
      const details = `cli_exit=${cli.status} cli_out=${JSON.stringify(cli.stdout)} cli_err=${JSON.stringify((cli.stderr ?? '').trim())} unit_exit=${unit.status} unit_err=${JSON.stringify((unit.stderr ?? '').trim())}`;
      return { fixed, complete, details };
    } finally {
      fs.rmSync(reproDir, { recursive: true, force: true });
    }
  }

  if (caseId === 'uc01-02-bug-test-fail') {
    const env = { ...scrubEnv(process.env), PYTHONPATH: workspaceDir, PYTHONDONTWRITEBYTECODE: '1' };
    const unit = spawnSync(
      python,
      [
        '-c',
        [
          'import tempfile, pathlib',
          'from tinydb_demo.store import Store',
          'd = tempfile.mkdtemp()',
          "s = Store(pathlib.Path(d) / 'db.json')",
          "s.add({'title': 'Hello World'})",
          "assert len(s.search('hello')) == 1",
          "assert len(s.search('HELLO')) == 1",
          "assert len(s.search('missing')) == 0",
        ].join('; '),
      ],
      { cwd: workspaceDir, env, encoding: 'utf8', timeout: 10_000 },
    );
    const searchTestPassed = afterPytest.passed.some((id) => id.includes('test_search_is_case_insensitive'));
    const complete = unit.status !== null && afterPytest.complete;
    const fixed = unit.status === 0 && searchTestPassed;
    const details = `unit_exit=${unit.status} search_test_passed=${searchTestPassed} unit_err=${JSON.stringify((unit.stderr ?? '').trim())}`;
    return { fixed, complete, details };
  }

  if (caseId === 'uc01-03-bug-reproducible') {
    const env = { ...scrubEnv(process.env), PYTHONPATH: workspaceDir, PYTHONDONTWRITEBYTECODE: '1' };
    const unit = spawnSync(
      python,
      [
        '-c',
        [
          'from tinydb_demo.pretty import render_table',
          "assert render_table([]) == ''",
          "assert render_table([{'a': 1, 'bb': 2}]) == 'a  bb'",
        ].join('; '),
      ],
      { cwd: workspaceDir, env, encoding: 'utf8', timeout: 10_000 },
    );
    const complete = unit.status !== null;
    const fixed = unit.status === 0;
    const details = `unit_exit=${unit.status} unit_err=${JSON.stringify((unit.stderr ?? '').trim())}`;
    return { fixed, complete, details };
  }

  throw new Error(`Unknown caseId: ${caseId}`);
}

const KNOWN_BASELINE_FAILURES_BY_CASE: Record<string, Set<string>> = {
  'uc01-01-bug-crash-null': new Set(['tests/test_search.py::test_search_is_case_insensitive']),
  'uc01-02-bug-test-fail': new Set(),
  'uc01-03-bug-reproducible': new Set(['tests/test_search.py::test_search_is_case_insensitive']),
};

export function verifyWorkspace(
  caseId: string,
  workspaceDir: string,
  opts?: {
    baselinePytest?: PytestSnapshot;
    fixtureDir?: string;
    agentStatus?: AgentStatus;
    pytestTimeoutMs?: number;
  },
): IndependentVerification {
  const agentStatus: AgentStatus = opts?.agentStatus ?? 'ok';
  const after = runExternalPytest(workspaceDir, opts?.pytestTimeoutMs ?? 15_000);
  const target = checkTargetBug(caseId, workspaceDir, after);
  const invariants = checkHealthyInvariants(workspaceDir);
  const testIntegrity = checkTestIntegrity(opts?.fixtureDir, workspaceDir);

  const regressionReasons: string[] = [];

  if (after.timedOut) regressionReasons.push('pytest timed out');
  if (!after.complete) regressionReasons.push('pytest did not reach session finish');
  if (after.errors.length > 0) regressionReasons.push(`pytest collection errors: ${after.errors.join(', ')}`);
  if (after.exitCode !== 0 && after.exitCode !== 1) {
    regressionReasons.push(`unexpected pytest exit code ${after.exitCode} (e.g. 2 = collection/usage error)`);
  }

  const allowedPreexisting = KNOWN_BASELINE_FAILURES_BY_CASE[caseId] ?? new Set<string>();
  const baselinePassed = new Set(opts?.baselinePytest?.passed ?? []);
  const baselineSkipped = new Set(opts?.baselinePytest?.skipped ?? []);
  const afterPassed = new Set(after.passed);
  const afterFailed = new Set(after.failed);
  const afterSkipped = new Set(after.skipped);

  for (const id of baselinePassed) {
    if (!afterPassed.has(id)) {
      regressionReasons.push(`baseline passing test regressed: ${id}`);
    }
  }
  for (const id of afterFailed) {
    if (!allowedPreexisting.has(id)) {
      regressionReasons.push(`unexpected/new failing test: ${id}`);
    }
  }
  for (const id of afterSkipped) {
    if (!baselineSkipped.has(id)) {
      regressionReasons.push(`newly skipped test: ${id}`);
    }
  }

  // If baseline had tests, ensure none disappeared silently
  if (opts?.baselinePytest) {
    const afterAll = new Set([...after.passed, ...after.failed, ...after.skipped]);
    for (const id of [...opts.baselinePytest.passed, ...opts.baselinePytest.failed]) {
      if (!afterAll.has(id)) {
        regressionReasons.push(`baseline test missing/deleted: ${id}`);
      }
    }
  }

  if (!invariants.ok) {
    regressionReasons.push(...invariants.errors);
  }
  if (!testIntegrity.ok) {
    regressionReasons.push(...testIntegrity.tamperingReasons);
  }

  const verificationComplete = after.complete && !after.timedOut && target.complete && invariants.complete;
  const noRegressions = regressionReasons.length === 0 && invariants.ok && testIntegrity.ok;
  const targetFixed = target.fixed;
  const overallPassed = targetFixed && noRegressions && verificationComplete && agentStatus === 'ok';

  return {
    passed: overallPassed,
    overallPassed,
    targetFixed,
    noRegressions,
    verificationComplete,
    agentStatus,
    details: `${target.details} | pytest_exit=${after.exitCode} | regressions=${regressionReasons.length}`,
    regressionReasons,
    invariantErrors: invariants.errors,
    testIntegrity,
    pytestExitCode: after.exitCode,
    pytestSummary: after.summary,
    pytest: after,
  };
}
