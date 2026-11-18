import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PytestReport {
  exitCode: number | null;
  failed: string[];
  passed: string[];
  skipped?: string[];
  collectionError: boolean;
  summary: string;
}

// Parse the test report separately from test stdout, which the workspace code can print freely.
const PARSE_JUNIT = String.raw`
import json, pathlib, sys, xml.etree.ElementTree as ET
root = pathlib.Path(sys.argv[2])
suites = ET.parse(sys.argv[1]).getroot()
out = {'passed': [], 'failed': [], 'skipped': [], 'errors': []}
for item in suites.iter('testcase'):
    classname = item.get('classname', '')
    name = item.get('name', '')
    parts = classname.split('.') if classname else []
    node = None
    for i in range(len(parts), 0, -1):
        relative = pathlib.Path(*parts[:i]).with_suffix('.py')
        if (root / relative).is_file():
            node = str(relative) + '::' + '::'.join(parts[i:] + [name])
            break
    if node is None:
        node = classname + '::' + name
    kind = 'errors' if item.find('error') is not None else 'failed' if item.find('failure') is not None else 'skipped' if item.find('skipped') is not None else 'passed'
    out[kind].append(node)
print(json.dumps(out))`;

export function runPytest(workspace: string, python = "python3", timeoutMs = 180_000, sandbox?: (args: string[], reportDir: string) => string[]): PytestReport {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ms-pytest-oracle-"));
  const xmlPath = path.join(directory, "results.xml");
  try {
    const args = ["-m", "pytest", "-q", "--tb=no", "-rA", "-p", "no:cacheprovider", `--junitxml=${xmlPath}`];
    const result = spawnSync(sandbox ? "/usr/bin/bwrap" : python, sandbox ? sandbox(args, directory) : args, {
      cwd: workspace, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const summary = output.trim().split("\n").slice(-1)[0] ?? "";
    const bad = (result.status !== 0 && result.status !== 1) || Boolean(result.error) || !fs.existsSync(xmlPath);
    if (bad) return { exitCode: result.status, failed: [], passed: [], skipped: [], collectionError: true, summary };
    const parser = spawnSync(python, ["-c", PARSE_JUNIT, xmlPath, workspace], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    if (parser.status !== 0 || parser.error) return { exitCode: result.status, failed: [], passed: [], skipped: [], collectionError: true, summary };
    let parsed: { failed: string[]; passed: string[]; skipped: string[]; errors: string[] };
    try { parsed = JSON.parse(parser.stdout); }
    catch { return { exitCode: result.status, failed: [], passed: [], skipped: [], collectionError: true, summary }; }
    const total = parsed.failed.length + parsed.passed.length + parsed.skipped.length + parsed.errors.length;
    return {
      exitCode: result.status,
      failed: parsed.failed,
      passed: parsed.passed,
      skipped: parsed.skipped,
      collectionError: total === 0 || parsed.errors.length > 0 || (result.status === 0 && parsed.failed.length > 0) || (result.status === 1 && parsed.failed.length === 0),
      summary,
    };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function assessPytestCoverage(baseline: PytestReport | null, post: PytestReport): {
  verificationComplete: boolean; noRegressions: boolean; newFailures: string[]; missingBaselineTests: string[]; newSkippedTests: string[];
} {
  const valid = (r: PytestReport) => !r.collectionError && (r.exitCode === 0 || r.exitCode === 1) && r.passed.length + r.failed.length > 0;
  const empty = { verificationComplete: false, noRegressions: false, newFailures: [], missingBaselineTests: [], newSkippedTests: [] };
  if (!valid(post) || (baseline && !valid(baseline))) return empty;
  if (!baseline) return { ...empty, verificationComplete: true, noRegressions: post.exitCode === 0 };
  const after = new Map<string, number>();
  for (const name of [...post.passed, ...post.failed]) after.set(name, (after.get(name) ?? 0) + 1);
  const missingBaselineTests: string[] = [];
  for (const name of [...baseline.passed, ...baseline.failed]) {
    const count = after.get(name) ?? 0;
    if (count) after.set(name, count - 1); else missingBaselineTests.push(name);
  }
  const baselineFailed = new Set(baseline.failed);
  const newFailures = post.failed.filter(name => !baselineFailed.has(name));
  const skipped = new Map<string, number>();
  for (const name of baseline.skipped ?? []) skipped.set(name, (skipped.get(name) ?? 0) + 1);
  const newSkippedTests = (post.skipped ?? []).filter(name => {
    const count = skipped.get(name) ?? 0;
    if (!count) return true;
    skipped.set(name, count - 1);
    return false;
  });
  const verificationComplete = missingBaselineTests.length === 0;
  return { verificationComplete, noRegressions: verificationComplete && !newFailures.length && !newSkippedTests.length, newFailures, missingBaselineTests, newSkippedTests };
}
