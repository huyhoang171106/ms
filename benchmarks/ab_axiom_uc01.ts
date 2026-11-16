import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../../nhom-30/src/core/agent-loop.js';
import { DEFAULT_CONFIG, loadConfig } from '../../nhom-30/src/core/config.js';
import { EventBus } from '../../nhom-30/src/core/event-bus.js';
import { pythonBin } from '../../nhom-30/src/core/paths.js';
import { buildSystemPrompt } from '../../nhom-30/src/core/prompt.js';
import { redact, registerSecret } from '../../nhom-30/src/core/secrets.js';
import { SessionManager } from '../../nhom-30/src/core/session.js';
import type { TokenUsage } from '../../nhom-30/src/core/types.js';
import { loadCatalog } from '../../nhom-30/src/llm/catalog/index.js';
import { CostTracker, type SessionSummary } from '../../nhom-30/src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../../nhom-30/src/llm/model-resolver.js';
import { BUNDLED_SKILLS_DIR } from '../../nhom-30/src/tools/bundled-skills.js';
import { ToolRegistry } from '../../nhom-30/src/tools/registry.js';
import { planSandbox } from '../../nhom-30/src/tools/sandbox.js';
import { MsAxiomAdapter } from '../examples/axiom_adapter.js';
import {
  aggregateNormalizedUsage,
  calculateNormalizedCost,
  normalizeProviderUsage,
  resolveModelPricing,
  type NormalizedUsage,
} from './ab_axiom_accounting.js';
import {
  aggregateExperimentSummary,
  appendRunRecord,
  buildExperimentSchedule,
  computeWorkspaceDiff,
  getGitProvenance,
  loadCompletedRunIds,
  loadRunRecords,
  redactConfigObject,
  SCHEMA_VERSION,
  sha256Directory,
  sha256File,
  type ArmName,
  type ExperimentManifest,
  type RequestUsageTrace,
  type RunRecord,
  type RunTraceArtifact,
  type ScheduledRun,
} from './ab_axiom_artifacts.js';
import {
  captureBaselinePytest,
  verifyWorkspace,
  type AgentStatus,
  type PytestSnapshot,
} from './ab_axiom_oracle.js';
import {
  buildToolTraceEntry,
  getArmToolDefinitionsHash,
  getExecutionPolicySnapshot,
  registerBaselineTools,
  registerMsTools,
  type BenchmarkMode,
  type BundledSkillMode,
  type ToolTraceEntry,
} from './ab_axiom_tools.js';

export const DEFAULT_MS_BIN = process.env.MS_BIN ?? '/home/hoang/ms/target/release/ms';
export const DEFAULT_FIXTURE_DIR = process.env.UC01_FIXTURE_DIR ?? '/home/hoang/nhom-30/evals/fixtures/uc01';
export const DEFAULT_CASES_DIR = process.env.UC01_CASES_DIR ?? '/home/hoang/nhom-30/evals/uc01';
export const DEFAULT_ARTIFACTS_ROOT = '/home/hoang/ms/benchmarks/artifacts';
export const DEFAULT_MODEL_SELECTOR = 'anthropic/claude-haiku-5-5';
export const TARGET_CASES = [
  'uc01-01-bug-crash-null',
  'uc01-02-bug-test-fail',
  'uc01-03-bug-reproducible',
] as const;

export interface CaseFixture {
  id: string;
  input: string;
}

export interface CliOptions {
  trials: number;
  seed: number;
  mode: BenchmarkMode;
  bundledSkillMode: BundledSkillMode;
  outDir?: string;
  resume?: string;
  cases: string[];
  model: string;
  maxSteps: number;
  budgetDollars: number;
  dryRun: boolean;
  msBin: string;
  fixtureDir: string;
  casesDir: string;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    trials: 1,
    seed: 42,
    mode: 'controlled',
    bundledSkillMode: 'on',
    cases: [...TARGET_CASES],
    model: DEFAULT_MODEL_SELECTOR,
    maxSteps: 20,
    budgetDollars: 1.0,
    dryRun: false,
    msBin: DEFAULT_MS_BIN,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    casesDir: DEFAULT_CASES_DIR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`Missing value for ${arg}`);
      return val;
    };

    if (arg === '--trials') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --trials: ${n}`);
      opts.trials = n;
    } else if (arg === '--seed') {
      const n = Number(next());
      if (!Number.isInteger(n)) throw new Error(`Invalid --seed: ${n}`);
      opts.seed = n;
    } else if (arg === '--mode') {
      const m = next();
      if (m !== 'controlled' && m !== 'native') throw new Error(`Invalid --mode: ${m}`);
      opts.mode = m;
    } else if (arg === '--bundled-skill-mode') {
      const m = next();
      if (m !== 'on' && m !== 'off') throw new Error(`Invalid --bundled-skill-mode: ${m}`);
      opts.bundledSkillMode = m;
    } else if (arg === '--out-dir') {
      opts.outDir = path.resolve(next());
    } else if (arg === '--resume') {
      opts.resume = next();
    } else if (arg === '--cases') {
      opts.cases = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--model') {
      opts.model = next();
    } else if (arg === '--max-steps') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --max-steps: ${n}`);
      opts.maxSteps = n;
    } else if (arg === '--budget') {
      const n = Number(next());
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --budget: ${n}`);
      opts.budgetDollars = n;
    } else if (arg === '--ms-bin') {
      opts.msBin = path.resolve(next());
    } else if (arg === '--fixture-dir') {
      opts.fixtureDir = path.resolve(next());
    } else if (arg === '--cases-dir') {
      opts.casesDir = path.resolve(next());
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: bun run benchmarks/ab_axiom_uc01.ts [options]
  --trials <n>        Paired trials per case (default: 1)
  --seed <n>          PRNG seed for AB/BA counterbalancing & case shuffle (default: 42)
  --mode <mode>               Execution parity mode: controlled | native (default: controlled)
  --bundled-skill-mode <m>    Shared bundled-skill fallback: on | off (default: on)
  --out-dir <dir>     External artifact directory (default: benchmarks/artifacts/<experimentId>)
  --resume <id|dir>   Resume an existing experiment directory or ID without duplicating runs
  --cases <list>      Comma-separated case IDs (default: all 3 uc01 bug cases)
  --model <selector>  Model selector (default: anthropic/claude-haiku-5-5)
  --max-steps <n>     Max agent steps per run (default: 20)
  --budget <usd>      Per-run budget limit in USD (default: 1.0)
  --dry-run           Run preflight checks and print schedule without calling LLM API`);
}

export function runPreflight(opts: CliOptions): {
  pricing: ReturnType<typeof resolveModelPricing>;
  baselinePytest: PytestSnapshot;
} {
  if (!fs.existsSync(opts.msBin)) {
    throw new Error(`Preflight failed: ms binary not found at ${opts.msBin}`);
  }
  fs.accessSync(opts.msBin, fs.constants.X_OK);

  if (!fs.existsSync(opts.fixtureDir)) {
    throw new Error(`Preflight failed: fixture dir not found at ${opts.fixtureDir}`);
  }
  for (const id of opts.cases) {
    const casePath = path.join(opts.casesDir, `${id}.json`);
    if (!fs.existsSync(casePath)) {
      throw new Error(`Preflight failed: case file not found at ${casePath}`);
    }
  }

  // Fail fast if model pricing is unknown (F1)
  const pricing = resolveModelPricing(opts.model);

  const python = pythonBin();
  const pyCheck = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf8', timeout: 5000 });
  if (pyCheck.status !== 0) {
    throw new Error(`Preflight failed: pytest unavailable via ${python}: ${pyCheck.stderr}`);
  }

  const baselinePytest = captureBaselinePytest(opts.fixtureDir);
  return { pricing, baselinePytest };
}

export function resolveOutDir(opts: CliOptions): { experimentId: string; outDir: string; isResume: boolean } {
  if (opts.resume) {
    const candidate = fs.existsSync(opts.resume)
      ? path.resolve(opts.resume)
      : path.join(DEFAULT_ARTIFACTS_ROOT, opts.resume);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Cannot resume: artifact directory not found at ${candidate}`);
    }
    return {
      experimentId: path.basename(candidate),
      outDir: candidate,
      isResume: true,
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const experimentId = `uc01-${opts.mode}-seed${opts.seed}-${stamp}`;
  const outDir = opts.outDir ?? path.join(DEFAULT_ARTIFACTS_ROOT, experimentId);
  return { experimentId, outDir, isResume: false };
}

export class NormalizedCostTracker extends CostTracker {
  private normalizedCostDollars = 0;

  override calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens?: number,
  ): number {
    const norm = normalizeProviderUsage({
      promptTokens,
      completionTokens,
      cacheReadInputTokens: cachedTokens,
    });
    return calculateNormalizedCost(model, norm).costDollars ?? 0;
  }

  override record(model: string, usage: TokenUsage): void {
    const norm = normalizeProviderUsage(usage);
    const calc = calculateNormalizedCost(model, norm);
    const usd = calc.costDollars ?? 0;
    this.normalizedCostDollars = Number((this.normalizedCostDollars + usd).toFixed(6));
    super.record(model, { ...usage, costEstimate: usd });
  }

  override getSessionSummary(): SessionSummary {
    const base = super.getSessionSummary();
    return {
      ...base,
      totalCost: this.normalizedCostDollars,
      totalCostDollars: this.normalizedCostDollars,
    };
  }

  override reset(): void {
    this.normalizedCostDollars = 0;
    super.reset();
  }
}

function makeEmptyUsage(): NormalizedUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWriteType: 'ephemeral_5m',
    output: 0,
    totalInputAll: 0,
    totalTokens: 0,
  };
}

export async function runSingle(
  scheduled: ScheduledRun,
  fixture: CaseFixture,
  ctx: {
    experimentId: string;
    outDir: string;
    opts: CliOptions;
    baselinePytest: PytestSnapshot;
  },
): Promise<RunRecord> {
  const wallStart = performance.now();
  const setupStart = performance.now();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${scheduled.arm}-${fixture.id}-`));
  const workspaceDir = path.join(tmpRoot, 'workspace');
  const sessionsDir = path.join(tmpRoot, 'sessions');
  const msStateDir = path.join(tmpRoot, 'ms-state');
  fs.cpSync(ctx.opts.fixtureDir, workspaceDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(msStateDir, { recursive: true });

  let msAdapter: MsAxiomAdapter | undefined;
  let msSessionId: string | undefined;
  let setupMs = 0;
  let agentMs = 0;
  let verifyMs = 0;
  let cleanupMs = 0;

  try {
    const config = loadConfig();
    const catalog = loadCatalog();
    const modelInfo = resolveModel(ctx.opts.model, catalog, config);
    const provider = await createProviderFor(modelInfo);
    const sandboxPlan = planSandbox();

    const bus = new EventBus();
    const costTracker = new NormalizedCostTracker();
    const registry = new ToolRegistry();
    registry.allowWithoutApprover = true;
    registry.bus = bus;

    if (scheduled.arm === 'B_ms') {
      msAdapter = new MsAxiomAdapter(ctx.opts.msBin, workspaceDir, msStateDir, true);
      msSessionId = await msAdapter.openSession({ allowWrite: true });
      registerMsTools(registry, msAdapter, msSessionId, ctx.opts.msBin, ctx.opts.mode, sandboxPlan, {
        bundledSkillMode: ctx.opts.bundledSkillMode,
      });
    } else {
      registerBaselineTools(registry, ctx.opts.bundledSkillMode);
    }

    const requestTraces: RequestUsageTrace[] = [];
    const normalizedRequests: NormalizedUsage[] = [];
    bus.on('cost_update', (usage: TokenUsage) => {
      const norm = normalizeProviderUsage(usage);
      normalizedRequests.push(norm);
      requestTraces.push({
        turn: requestTraces.length + 1,
        usage: norm,
        cost: calculateNormalizedCost(modelInfo.id, norm),
      });
    });

    const toolTraces: ToolTraceEntry[] = [];
    const toolErrors: Array<{ name: string; error: string }> = [];
    const pendingStarts = new Map<
      string,
      { name: string; startedAtMonoMs: number; turnIndex: number; args: unknown }
    >();
    bus.on('tool_call_start', (tc) => {
      pendingStarts.set(tc.id, {
        name: tc.name,
        startedAtMonoMs: performance.now() - wallStart,
        turnIndex: requestTraces.length,
        args: tc.arguments,
      });
    });
    bus.on('tool_call_end', (res) => {
      const startInfo = pendingStarts.get(res.toolCallId);
      const name = res.name || startInfo?.name || 'unknown';
      const startedAtMonoMs = startInfo?.startedAtMonoMs ?? performance.now() - wallStart;
      const durationMs = typeof res.metadata?.durationMs === 'number' ? res.metadata.durationMs : 0;
      const entry = buildToolTraceEntry(
        res.toolCallId,
        name,
        startedAtMonoMs,
        durationMs,
        String(res.output ?? ''),
        Boolean(res.isError),
        res.error,
        {
          turnIndex: startInfo?.turnIndex ?? requestTraces.length,
          args: startInfo?.args,
        },
      );
      toolTraces.push(entry);
      if (entry.isError && entry.errorPreview) {
        toolErrors.push({ name, error: entry.errorPreview });
      }
    });

    const loop = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: workspaceDir },
      provider,
      model: modelInfo.id,
      toolRegistry: registry,
      sessionManager: new SessionManager({ workspaceRoot: workspaceDir, sessionsDir, autoSave: false }),
      costTracker,
      eventBus: bus,
      systemPrompt: `${buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, workspaceDir)}\n\nEnvironment:\n- Workspace root: ${workspaceDir}\n- Use relative paths from the workspace root for project files.`,
      maxSteps: ctx.opts.maxSteps,
      budgetLimitDollars: ctx.opts.budgetDollars,
    });

    const prompt = [
      'Fix the following bug in the workspace. Reproduce or verify it, apply the minimal fix, and run tests/checks to confirm.',
      '',
      fixture.input,
    ].join('\n');

    setupMs = Number((performance.now() - setupStart).toFixed(2));

    const agentStart = performance.now();
    const taskResult = await loop.runTask(prompt);
    agentMs = Number((performance.now() - agentStart).toFixed(2));

    if (msAdapter && msSessionId) {
      await msAdapter.closeSession(msSessionId).catch(() => {});
      msAdapter.shutdown();
      msAdapter = undefined;
    }

    const agentStatus: AgentStatus =
      taskResult.status === 'completed'
        ? 'ok'
        : taskResult.error && /timeout|timed out|abort/i.test(taskResult.error)
          ? 'timeout'
          : 'error';

    const verifyStart = performance.now();
    const verified = verifyWorkspace(fixture.id, workspaceDir, {
      baselinePytest: ctx.baselinePytest,
      fixtureDir: ctx.opts.fixtureDir,
      agentStatus,
    });
    const diff = computeWorkspaceDiff(ctx.opts.fixtureDir, workspaceDir);
    verifyMs = Number((performance.now() - verifyStart).toFixed(2));

    const cleanupStart = performance.now();
    const tracesDir = path.join(ctx.outDir, 'traces');
    const patchesDir = path.join(ctx.outDir, 'patches');
    fs.mkdirSync(tracesDir, { recursive: true });
    fs.mkdirSync(patchesDir, { recursive: true });

    const traceRel = `traces/${scheduled.runId}.json`;
    const patchRel = `patches/${scheduled.runId}.diff`;

    const aggregated = aggregateNormalizedUsage(normalizedRequests, modelInfo.id);
    const byName: Record<string, { total: number; failures: number; nonZeroExits: number }> = {};
    for (const tc of toolTraces) {
      byName[tc.name] ??= { total: 0, failures: 0, nonZeroExits: 0 };
      byName[tc.name]!.total += 1;
      if (tc.isError) byName[tc.name]!.failures += 1;
      if (tc.exitCode !== null && tc.exitCode !== 0) byName[tc.name]!.nonZeroExits += 1;
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    cleanupMs = Number((performance.now() - cleanupStart).toFixed(2));
    const wallClockMs = Number((performance.now() - wallStart).toFixed(2));

    const durationsMs = { setupMs, agentMs, verifyMs, cleanupMs, wallClockMs };

    const traceArtifact: RunTraceArtifact = {
      schemaVersion: SCHEMA_VERSION,
      experimentId: ctx.experimentId,
      runId: scheduled.runId,
      arm: scheduled.arm,
      caseId: fixture.id,
      trial: scheduled.trial,
      pairOrder: scheduled.pairOrder,
      durationsMs,
      requests: requestTraces,
      toolCalls: toolTraces,
      actualFilesChanged: diff.filesChanged,
      diffBytes: diff.diffBytes,
      diffTruncated: diff.truncated,
    };
    fs.writeFileSync(path.join(ctx.outDir, traceRel), JSON.stringify(traceArtifact, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(ctx.outDir, patchRel), diff.diffText, 'utf8');

    return {
      schemaVersion: SCHEMA_VERSION,
      experimentId: ctx.experimentId,
      runId: scheduled.runId,
      trial: scheduled.trial,
      caseId: fixture.id,
      arm: scheduled.arm,
      pairOrder: scheduled.pairOrder,
      mode: ctx.opts.mode,
      recordedAt: new Date().toISOString(),
      status: taskResult.status,
      agentStatus,
      ...(taskResult.error ? { error: redact(taskResult.error) } : {}),
      verified,
      durationsMs,
      wallClockMs,
      llmTurns: requestTraces.length,
      toolCallsTotal: toolTraces.length,
      toolFailures: toolTraces.filter((t) => t.isError).length,
      commandNonZeroExits: toolTraces.filter((t) => t.exitCode !== null && t.exitCode !== 0).length,
      commandTimeouts: toolTraces.filter((t) => t.timedOut).length,
      toolOutputBytesTotal: toolTraces.reduce((s, t) => s + t.toolOutputBytes, 0),
      toolErrors,
      toolCallsByName: byName,
      usage: aggregated.totals,
      costDollars: aggregated.cost.costDollars,
      costKind: aggregated.cost.costKind,
      pricingCanonicalId: aggregated.cost.pricing.canonicalId,
      filesChangedAgent: taskResult.filesChanged,
      filesChangedActual: diff.filesChanged,
      tracePath: traceRel,
      patchPath: patchRel,
    };
  } finally {
    if (msAdapter) {
      if (msSessionId) await msAdapter.closeSession(msSessionId).catch(() => {});
      msAdapter.shutdown();
    }
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

export function buildInfraErrorRecord(
  scheduled: ScheduledRun,
  experimentId: string,
  mode: BenchmarkMode,
  model: string,
  err: unknown,
  wallClockMs: number,
): RunRecord {
  const message = redact(err instanceof Error ? err.message : String(err));
  let pricingCanonicalId = model;
  let isUnpriced = false;
  try {
    const pricing = resolveModelPricing(model);
    pricingCanonicalId = pricing.canonicalId;
    isUnpriced = pricing.pricingStatus === 'unpriced';
  } catch {
    // Keep raw model identifier on infra error record if pricing lookup itself failed
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    experimentId,
    runId: scheduled.runId,
    trial: scheduled.trial,
    caseId: scheduled.caseId,
    arm: scheduled.arm,
    pairOrder: scheduled.pairOrder,
    mode,
    recordedAt: new Date().toISOString(),
    status: 'infra_error',
    agentStatus: 'error',
    infraError: message,
    error: message,
    verified: {
      passed: false,
      overallPassed: false,
      targetFixed: false,
      noRegressions: false,
      verificationComplete: false,
      agentStatus: 'error',
      details: `infra_error: ${message}`,
      regressionReasons: [],
      invariantErrors: [],
      testIntegrity: { ok: true, tamperingReasons: [], modifiedExistingTestFiles: [], addedTestFiles: [] },
      pytestExitCode: null,
      pytestSummary: '',
      pytest: {
        passed: [],
        failed: [],
        skipped: [],
        errors: [],
        complete: false,
        timedOut: false,
        exitCode: null,
        summary: '',
      },
    },
    durationsMs: {
      setupMs: 0,
      agentMs: 0,
      verifyMs: 0,
      cleanupMs: 0,
      wallClockMs: Number(wallClockMs.toFixed(2)),
    },
    wallClockMs: Number(wallClockMs.toFixed(2)),
    llmTurns: 0,
    toolCallsTotal: 0,
    toolFailures: 0,
    commandNonZeroExits: 0,
    commandTimeouts: 0,
    toolOutputBytesTotal: 0,
    toolErrors: [],
    toolCallsByName: {},
    usage: makeEmptyUsage(),
    costDollars: isUnpriced ? null : 0,
    costKind: isUnpriced ? 'unpriced' : 'estimated',
    pricingCanonicalId,
    filesChangedAgent: [],
    filesChangedActual: [],
    tracePath: '',
    patchPath: '',
  };
}

export async function runExperiment(
  opts: CliOptions,
  deps?: {
    runSingleFn?: typeof runSingle;
  },
): Promise<{ outDir: string; manifest: ExperimentManifest; runs: RunRecord[] }> {
  if (process.env.TROLLLLM_API_KEY) {
    registerSecret(process.env.TROLLLLM_API_KEY);
  }
  const { experimentId, outDir, isResume } = resolveOutDir(opts);
  fs.mkdirSync(outDir, { recursive: true });

  const manifestPath = path.join(outDir, 'manifest.json');
  const jsonlPath = path.join(outDir, 'runs.jsonl');

  let manifest: ExperimentManifest;
  let effectiveOpts: CliOptions = opts;
  let baselinePytest: PytestSnapshot;

  if (isResume && fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExperimentManifest;
    effectiveOpts = {
      ...opts,
      mode: manifest.mode,
      bundledSkillMode: manifest.featureFlags?.bundledSkillMode ?? opts.bundledSkillMode,
      seed: manifest.seed,
      trials: manifest.trials,
      cases: manifest.cases,
      model: manifest.modelSelector,
      maxSteps: manifest.generationSettings.maxSteps,
      budgetDollars: manifest.generationSettings.budgetLimitDollars,
      msBin: manifest.msBinaryPath,
      fixtureDir: manifest.fixtureDir,
      casesDir: manifest.casesDir,
    };
    baselinePytest = runPreflight(effectiveOpts).baselinePytest;
  } else {
    const preflight = runPreflight(effectiveOpts);
    baselinePytest = preflight.baselinePytest;
    const pricing = preflight.pricing;
    const config = loadConfig();
    const catalog = loadCatalog();
    const resolvedModel = resolveModel(effectiveOpts.model, catalog, config).id;
    const sandboxPlan = planSandbox();
    const schedule = buildExperimentSchedule(effectiveOpts.cases, effectiveOpts.trials, effectiveOpts.seed);
    const featureFlags = {
      bundledSkillMode: effectiveOpts.bundledSkillMode,
    };
    const systemPromptText = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, effectiveOpts.fixtureDir);
    const bundledSkillPath = path.join(BUNDLED_SKILLS_DIR, 'bug-fix', 'SKILL.md');

    manifest = {
      schemaVersion: SCHEMA_VERSION,
      experimentId,
      createdAt: new Date().toISOString(),
      mode: effectiveOpts.mode,
      seed: effectiveOpts.seed,
      trials: effectiveOpts.trials,
      cases: effectiveOpts.cases,
      modelSelector: effectiveOpts.model,
      resolvedModel,
      pricing,
      costKind: pricing.pricingStatus === 'unpriced' ? 'unpriced' : 'estimated',
      msBinaryPath: effectiveOpts.msBin,
      fixtureDir: effectiveOpts.fixtureDir,
      casesDir: effectiveOpts.casesDir,
      git: {
        ms: getGitProvenance('/home/hoang/ms'),
        nhom30: getGitProvenance('/home/hoang/nhom-30'),
      },
      hashes: {
        msBinarySha256: sha256File(effectiveOpts.msBin),
        fixtureSha256: sha256Directory(effectiveOpts.fixtureDir),
        adapterSha256: sha256File('/home/hoang/ms/examples/axiom_adapter.ts'),
        systemPromptSha256: crypto.createHash('sha256').update(systemPromptText).digest('hex'),
        bundledSkillSha256: sha256File(bundledSkillPath),
        featureConfigSha256: crypto.createHash('sha256').update(JSON.stringify(featureFlags)).digest('hex'),
        toolDefinitionsSha256: {
          A_baseline: getArmToolDefinitionsHash('A_baseline', effectiveOpts.mode, effectiveOpts.msBin, sandboxPlan),
          B_ms: getArmToolDefinitionsHash('B_ms', effectiveOpts.mode, effectiveOpts.msBin, sandboxPlan),
        },
      },
      featureFlags,
      generationSettings: {
        maxSteps: effectiveOpts.maxSteps,
        budgetLimitDollars: effectiveOpts.budgetDollars,
      },
      executionPolicy: {
        A_baseline: getExecutionPolicySnapshot(effectiveOpts.mode, 'A_baseline', sandboxPlan),
        B_ms: getExecutionPolicySnapshot(effectiveOpts.mode, 'B_ms', sandboxPlan),
      },
      redactedConfigSnapshot: redactConfigObject({
        ...config,
        defaultModel: resolvedModel,
        maxSteps: effectiveOpts.maxSteps,
        budgetLimitDollars: effectiveOpts.budgetDollars,
      }) as Record<string, unknown>,
      schedule,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  if (effectiveOpts.dryRun) {
    console.log(`[dry-run] Preflight OK. Experiment ${manifest.experimentId}`);
    console.log(`[dry-run] Mode=${manifest.mode}, Seed=${manifest.seed}, Trials=${manifest.trials}, Runs=${manifest.schedule.length}`);
    if (manifest.pricing.pricingStatus === 'unpriced') {
      console.log(`[dry-run] Pricing=${manifest.pricing.canonicalId} (unpriced: token-only accounting)`);
    } else {
      console.log(`[dry-run] Pricing=${manifest.pricing.canonicalId} (in=$${manifest.pricing.inputPer1M}/1M, cacheRead=$${manifest.pricing.cacheReadPer1M}/1M, cacheWrite=$${manifest.pricing.cacheWrite5mPer1M}/1M, out=$${manifest.pricing.outputPer1M}/1M)`);
    }
    console.log(`[dry-run] Baseline pytest: passed=${baselinePytest.passed.length}, failed=${baselinePytest.failed.length} (${baselinePytest.failed.join(', ')})`);
    return { outDir, manifest, runs: loadRunRecords(jsonlPath) };
  }

  const casesById = new Map<string, CaseFixture>();
  for (const id of manifest.cases) {
    const raw = fs.readFileSync(path.join(effectiveOpts.casesDir, `${id}.json`), 'utf8');
    casesById.set(id, JSON.parse(raw) as CaseFixture);
  }

  const completed = loadCompletedRunIds(jsonlPath);
  const executor = deps?.runSingleFn ?? runSingle;

  for (const scheduled of manifest.schedule) {
    if (completed.has(scheduled.runId)) {
      console.log(`[resume] Skipping already completed ${scheduled.runId}`);
      continue;
    }

    const fixture = casesById.get(scheduled.caseId);
    if (!fixture) {
      const errRec = buildInfraErrorRecord(
        scheduled,
        manifest.experimentId,
        manifest.mode,
        manifest.resolvedModel,
        new Error(`Missing fixture for ${scheduled.caseId}`),
        0,
      );
      appendRunRecord(jsonlPath, errRec);
      continue;
    }

    console.log(`Running ${scheduled.runId} (pair=${scheduled.pairOrder})...`);
    const t0 = performance.now();
    try {
      const record = await executor(scheduled, fixture, {
        experimentId: manifest.experimentId,
        outDir,
        opts: effectiveOpts,
        baselinePytest,
      });
      appendRunRecord(jsonlPath, record);
      const costLabel = record.costDollars === null ? 'unpriced' : `$${record.costDollars.toFixed(6)}`;
      console.log(
        `  -> overall=${record.verified.overallPassed} target=${record.verified.targetFixed} noReg=${record.verified.noRegressions} turns=${record.llmTurns} tools=${record.toolCallsTotal} (err=${record.toolFailures}, nz=${record.commandNonZeroExits}) estCost=${costLabel} time=${record.wallClockMs}ms`,
      );
    } catch (err) {
      const errRec = buildInfraErrorRecord(
        scheduled,
        manifest.experimentId,
        manifest.mode,
        manifest.resolvedModel,
        err,
        performance.now() - t0,
      );
      appendRunRecord(jsonlPath, errRec);
      console.error(`  -> INFRA ERROR recorded for ${scheduled.runId}: ${errRec.infraError}`);
    }
  }

  const allRuns = loadRunRecords(jsonlPath);
  const summary = aggregateExperimentSummary(allRuns, manifest);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`\nArtifacts saved to ${outDir}`);
  return { outDir, manifest, runs: allRuns };
}

if (import.meta.main) {
  const opts = parseCliArgs(process.argv.slice(2));
  runExperiment(opts).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
