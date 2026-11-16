import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../../nhom-30/src/core/agent-loop.js';
import { DEFAULT_CONFIG, loadConfig } from '../../nhom-30/src/core/config.js';
import { EventBus } from '../../nhom-30/src/core/event-bus.js';
import { buildSystemPrompt } from '../../nhom-30/src/core/prompt.js';
import { redact } from '../../nhom-30/src/core/secrets.js';
import { SessionManager } from '../../nhom-30/src/core/session.js';
import type { TokenUsage } from '../../nhom-30/src/core/types.js';
import { loadCatalog } from '../../nhom-30/src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../../nhom-30/src/llm/model-resolver.js';
import { ToolRegistry } from '../../nhom-30/src/tools/registry.js';
import { planSandbox } from '../../nhom-30/src/tools/sandbox.js';
import { MsAxiomAdapter } from '../examples/axiom_adapter.js';
import {
  aggregateNormalizedUsage,
  calculateNormalizedCost,
  normalizeProviderUsage,
  resolveModelPricing,
} from './ab_axiom_accounting.js';
import {
  aggregateExperimentSummary,
  appendRunRecord,
  buildExperimentSchedule,
  computeWorkspaceDiff,
  redactConfigObject,
  SCHEMA_VERSION,
  type ArmName,
  type RunRecord,
  type RunTraceArtifact,
} from './ab_axiom_artifacts.js';
import { checkTestIntegrity, runExternalPytest } from './ab_axiom_oracle.js';
import {
  buildToolTraceEntry,
  registerBaselineTools,
  registerMsTools,
  type ToolTraceEntry,
} from './ab_axiom_tools.js';
import { NormalizedCostTracker } from './ab_axiom_uc01.js';

const FIXTURE_DIR = '/home/hoang/ms/benchmarks/fixtures/medium-repo-eval';
const DEFAULT_OUT_DIR = '/home/hoang/ms/benchmarks/artifacts/claude-haiku-5-5-medium-t4-seed42';
const DEFAULT_MS_BIN = '/home/hoang/ms/target/release/ms';

interface MediumCase {
  id: string;
  testFile: string;
  prompt: string;
  requiredPassingNodeIds: string[];
}

const MEDIUM_CASES: MediumCase[] = [
  {
    id: 'med-01-pagination-offbyone',
    testFile: 'tests/test_api_pagination.py',
    prompt:
      'Fix the bug where `handle_list_tasks` / `paginate_items` returns the wrong slice for page 1 and page 2 (`tests/test_api_pagination.py` is failing). Keep all existing tests passing and do not modify existing test files.',
    requiredPassingNodeIds: [
      'tests/test_api_pagination.py::test_pagination_first_page',
      'tests/test_api_pagination.py::test_pagination_second_page',
    ],
  },
  {
    id: 'med-02-retry-backoff',
    testFile: 'tests/test_scheduler.py',
    prompt:
      'Fix the bug where `compute_backoff_ms` ignores `max_delay_ms` cap (`tests/test_scheduler.py::test_backoff_caps_at_max_delay` is failing). Keep all existing tests passing and do not modify existing test files.',
    requiredPassingNodeIds: ['tests/test_scheduler.py::test_backoff_caps_at_max_delay'],
  },
  {
    id: 'med-03-export-csv-escape',
    testFile: 'tests/test_export.py',
    prompt:
      'Fix the bug where `export_tasks_csv` crashes when `task.metadata` is `None` (`tests/test_export.py::test_csv_export_handles_none_metadata` is failing). Keep all existing tests passing and do not modify existing test files.',
    requiredPassingNodeIds: ['tests/test_export.py::test_csv_export_handles_none_metadata'],
  },
];

async function runSingle(
  runId: string,
  arm: ArmName,
  c: MediumCase,
  trial: number,
  pairOrder: 'AB' | 'BA',
  outDir: string,
  modelSelector: string,
): Promise<RunRecord> {
  const tStart = performance.now();
  const root = fs.mkdtempSync(path.join('/dev/shm/hoang-agent-tmp', `med-${arm}-${c.id}-`));
  const ws = path.join(root, 'workspace');
  const stateDir = path.join(root, 'ms-state');
  fs.cpSync(FIXTURE_DIR, ws, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const cfg = loadConfig(ws);
  const catalog = loadCatalog();
  const modelInfo = resolveModel(modelSelector, catalog, cfg);
  const pricing = resolveModelPricing(modelInfo.id);
  const provider = await createProviderFor(modelInfo);
  const sandboxPlan = planSandbox();
  const registry = new ToolRegistry();
  registry.allowWithoutApprover = true;

  let msAdapter: MsAxiomAdapter | undefined;
  let msSessionId: string | undefined;

  if (arm === 'B_ms') {
    msAdapter = new MsAxiomAdapter(DEFAULT_MS_BIN, ws, stateDir, true);
    await msAdapter.initialize();
    msSessionId = await msAdapter.openSession({ allowWrite: true });
    registerMsTools(registry, msAdapter, msSessionId, DEFAULT_MS_BIN, 'controlled', sandboxPlan);
  } else {
    registerBaselineTools(registry, 'on');
  }

  const bus = new EventBus();
  const sessions = new SessionManager({ workspaceRoot: ws, sessionsDir: path.join(root, 'sessions'), autoSave: false });
  const costTracker = new NormalizedCostTracker();
  registry.bus = bus;
  const toolCalls: ToolTraceEntry[] = [];
  const requestTraces: RunTraceArtifact['requests'] = [];

  bus.on('cost_update', (usage: TokenUsage) => {
    const n = normalizeProviderUsage(usage);
    const cost = calculateNormalizedCost(modelInfo.id, n);
    requestTraces.push({ turn: requestTraces.length + 1, usage: n, cost });
  });
  const pendingStarts = new Map<string, { name: string; startedAt: number; turnIndex: number; args: unknown }>();
  bus.on('tool_call_start', (tc) => {
    pendingStarts.set(tc.id, {
      name: tc.name,
      startedAt: performance.now() - tStart,
      turnIndex: requestTraces.length,
      args: tc.arguments,
    });
  });
  bus.on('tool_call_end', (res) => {
    const meta = pendingStarts.get(res.toolCallId);
    pendingStarts.delete(res.toolCallId);
    const name = res.name || meta?.name || 'unknown';
    const durationMs = typeof res.metadata?.durationMs === 'number' ? res.metadata.durationMs : 0;
    toolCalls.push(
      buildToolTraceEntry(
        res.toolCallId,
        name,
        meta?.startedAt ?? performance.now() - tStart,
        durationMs,
        String(res.output ?? ''),
        Boolean(res.isError),
        res.error,
        { turnIndex: meta?.turnIndex ?? requestTraces.length, args: meta?.args },
      ),
    );
  });

  const sysPrompt = `${buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, ws)}\n\nEnvironment:\n- Workspace root: ${ws}\n- Use relative paths from the workspace root for project files.`;
  const loop = new AgentLoop({
    config: { ...DEFAULT_CONFIG, workspaceRoot: ws },
    provider,
    model: modelInfo.id,
    toolRegistry: registry,
    sessionManager: sessions,
    costTracker,
    eventBus: bus,
    systemPrompt: sysPrompt,
    maxSteps: 20,
    budgetLimitDollars: 2.0,
  });

  const tAgentStart = performance.now();
  let agentStatus: 'ok' | 'timeout' | 'error' = 'ok';
  let statusReason: string | undefined;
  let resultFilesChanged: string[] = [];
  let llmTurns = 0;
  try {
    const taskResult = await loop.runTask(c.prompt);
    llmTurns = taskResult.turns ?? requestTraces.length;
    resultFilesChanged = taskResult.filesChanged ?? [];
    if (taskResult.status !== 'completed') {
      agentStatus = taskResult.error && /timeout|timed out|abort/i.test(taskResult.error) ? 'timeout' : 'error';
      statusReason = taskResult.error ?? taskResult.status;
    }
  } catch (err) {
    agentStatus = 'error';
    statusReason = err instanceof Error ? err.message : String(err);
  } finally {
    if (msAdapter && msSessionId) {
      await msAdapter.closeSession(msSessionId).catch(() => {});
    }
    msAdapter?.shutdown();
  }
  const agentMs = performance.now() - tAgentStart;

  const tVerStart = performance.now();
  const snap = runExternalPytest(ws, 20_000);
  const integrity = checkTestIntegrity(FIXTURE_DIR, ws);
  const targetFixed = c.requiredPassingNodeIds.every((id) => snap.passed.includes(id));
  const targetFileFailures = snap.failed.filter((id) => id.startsWith(`${c.testFile}::`));
  const noRegressions = integrity.ok && snap.errors.length === 0 && targetFileFailures.length === 0;
  const overallPassed = agentStatus === 'ok' && targetFixed && noRegressions && snap.complete;
  const verifyMs = performance.now() - tVerStart;

  const diff = computeWorkspaceDiff(FIXTURE_DIR, ws);
  const tracesDir = path.join(outDir, 'traces');
  const patchesDir = path.join(outDir, 'patches');
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.mkdirSync(patchesDir, { recursive: true });
  const traceRel = `traces/${runId}.json`;
  const patchRel = `patches/${runId}.diff`;
  fs.writeFileSync(path.join(outDir, patchRel), diff.diffText ?? '', 'utf8');
  fs.writeFileSync(
    path.join(outDir, traceRel),
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        experimentId: 'medium-repo-eval',
        runId,
        arm,
        caseId: c.id,
        trial,
        pairOrder,
        durationsMs: { setupMs: 0, agentMs, verifyMs, cleanupMs: 0, wallClockMs: performance.now() - tStart },
        requests: requestTraces,
        toolCalls,
        actualFilesChanged: diff.actualFilesChanged,
        diffBytes: diff.diffBytes,
        diffTruncated: diff.diffTruncated,
      },
      null,
      2,
    ),
  );
  fs.rmSync(root, { recursive: true, force: true });

  const agg = aggregateNormalizedUsage(
    requestTraces.map((r) => r.usage),
    modelInfo.id,
  );
  const usage = agg.totals;
  const costInfo = agg.cost;
  const toolCallsByName: Record<string, number> = {};
  for (const t of toolCalls) toolCallsByName[t.name] = (toolCallsByName[t.name] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    experimentId: 'medium-repo-eval',
    runId,
    trial,
    caseId: c.id,
    arm,
    pairOrder,
    mode: 'controlled',
    recordedAt: new Date().toISOString(),
    status: 'completed',
    agentStatus,
    ...(statusReason ? { errorMessage: redact(statusReason) } : {}),
    verified: {
      overallPassed,
      targetFixed,
      noRegressions,
      verificationComplete: snap.complete,
      details: `${c.id}: fixed=${targetFixed}, failed=${snap.failed.length}, err=${snap.errors.length}`,
      regressionReasons: snap.failed,
      invariantErrors: [],
      testIntegrity: integrity,
      pytestExitCode: snap.exitCode,
      pytestSummary: snap.summary,
    },
    durationsMs: { setupMs: 0, agentMs, verifyMs, cleanupMs: 0 },
    wallClockMs: Number((performance.now() - tStart).toFixed(2)),
    llmTurns,
    toolCallsTotal: toolCalls.length,
    toolFailures: toolCalls.filter((t) => t.isError).length,
    commandNonZeroExits: toolCalls.filter((t) => t.exitCode !== null && t.exitCode !== 0).length,
    commandTimeouts: toolCalls.filter((t) => t.timedOut).length,
    toolOutputBytesTotal: toolCalls.reduce((s, t) => s + t.toolOutputBytes, 0),
    toolErrors: [],
    toolCallsByName,
    usage: {
      uncachedInput: usage.uncachedInput,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      totalInputAll: usage.totalInputAll,
      totalTokens: usage.totalTokens,
    },
    costDollars: costInfo.costDollars,
    costKind: costInfo.costKind,
    pricingCanonicalId: costInfo.pricing.canonicalId,
    filesChangedAgent: resultFilesChanged,
    filesChangedActual: diff.actualFilesChanged,
    tracePath: traceRel,
    patchPath: patchRel,
  };
}

async function main() {
  const trials = Number(process.argv[2] ?? 4);
  const outDir = process.argv[3] ?? DEFAULT_OUT_DIR;
  const model = process.argv[4] ?? 'anthropic/claude-haiku-5-5';
  fs.mkdirSync(outDir, { recursive: true });
  const runsPath = path.join(outDir, 'runs.jsonl');
  const schedule = buildExperimentSchedule(
    MEDIUM_CASES.map((c) => c.id),
    trials,
    42,
  );
  const records: RunRecord[] = [];
  for (const item of schedule) {
    const c = MEDIUM_CASES.find((x) => x.id === item.caseId)!;
    console.log(`Running ${item.runId} (pair=${item.pairOrder})...`);
    const rec = await runSingle(item.runId, item.arm, c, item.trial, item.pairOrder, outDir, model);
    records.push(rec);
    appendRunRecord(runsPath, rec);
    console.log(
      `  -> overall=${rec.verified.overallPassed} turns=${rec.llmTurns} tools=${rec.toolCallsTotal} tok=${rec.usage.totalTokens} time=${rec.wallClockMs}ms`,
    );
  }
  const summary = aggregateExperimentSummary(records, {
    experimentId: 'medium-repo-eval',
    mode: 'controlled',
    seed: 42,
    trials,
    cases: MEDIUM_CASES.map((c) => c.id),
  });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nSaved medium-repo-eval summary to ${path.join(outDir, 'summary.json')}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
