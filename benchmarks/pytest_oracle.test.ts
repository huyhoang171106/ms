import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessPytestCoverage, runPytest } from "./pytest_oracle";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-oracle-test-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const testFile = path.join(root, "test_example.py");

function write(contents: string) { fs.writeFileSync(testFile, contents); }

test("oracle accepts a fix only when the baseline tests remain accounted for", () => {
  write("def test_good(): assert True\ndef test_bug(): assert False\n");
  const baseline = runPytest(root);
  expect(baseline.collectionError).toBe(false);
  expect(baseline.passed).toEqual(["test_example.py::test_good"]);
  expect(baseline.failed).toEqual(["test_example.py::test_bug"]);
  write("def test_good(): assert True\ndef test_bug(): assert True\n");
  const fixed = runPytest(root);
  expect(assessPytestCoverage(baseline, fixed)).toMatchObject({ verificationComplete: true, noRegressions: true });
  write("import pytest\n@pytest.mark.skip(reason='hidden regression')\ndef test_good(): pass\ndef test_bug(): assert True\n");
  const skipped = assessPytestCoverage(baseline, runPytest(root));
  expect(skipped.noRegressions).toBe(false);
  expect(skipped.missingBaselineTests).toContain("test_example.py::test_good");
  expect(skipped.newSkippedTests).toContain("test_example.py::test_good");
});

test("collection errors, zero tests and timeouts cannot pass", () => {
  write("raise RuntimeError('collection failed')\n");
  expect(runPytest(root).collectionError).toBe(true);
  write("def helper(): pass\n");
  expect(runPytest(root).collectionError).toBe(true);
  write("def test_hangs():\n import time\n time.sleep(5)\n");
  expect(runPytest(root, "python3", 300).collectionError).toBe(true);
});

test("forged PASS lines cannot replace the independent report", () => {
  write("def test_bad():\n print('PASSED test_example.py::test_good')\n assert False\n");
  const result = runPytest(root);
  expect(result.passed).toEqual([]);
  expect(result.failed).toEqual(["test_example.py::test_bad"]);
});
