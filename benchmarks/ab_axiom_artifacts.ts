import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { redact, SECRET_NAME } from '../../nhom-30/axiom-cli/src/core/secrets.js';
import type { CostCalculation, ModelPricingEntry, NormalizedUsage } from './ab_axiom_accounting.js';
import type { AgentStatus, IndependentVerification } from './ab_axiom_oracle.js';
import type { BenchmarkMode, BundledSkillMode, ExecutionPolicySnapshot, ToolTraceEntry } from './ab_axiom_tools.js';

export const SCHEMA_VERSION = '2.0.0';

export type ArmName = 'A_baseline' | 'B_ms';

export interface ScheduledRun {
  runId: string;
  trial: number;
  caseId: string;
  arm: ArmName;
  pairOrder: 'AB' | 'BA';
  caseOrderIndex: number;
}

export interface GitProvenance {
  commit: string;
  dirty: boolean;
  dirtyHash: string | null;
}

export interface ExperimentManifest {
  schemaVersion: string;
  experimentId: string;
  createdAt: string;
  mode: BenchmarkMode;
  seed: number;
  trials: number;
  cases: string[];
  modelSelector: string;
  resolvedModel: string;
  pricing: ModelPricingEntry;
  costKind: 'estimated' | 'unpriced';
  msBinaryPath: string;
  fixtureDir: string;
  casesDir: string;
  git: {
    ms: GitProvenance;
    nhom30: GitProvenance;
  };
  hashes: {
    msBinarySha256: string;
    fixtureSha256: string;
    adapterSha256: string;
    systemPromptSha256: string;
    bundledSkillSha256?: string;
    featureConfigSha256?: string;
    toolDefinitionsSha256?: Partial<Record<ArmName, string>>;
  };
  featureFlags?: {
    bundledSkillMode: BundledSkillMode;
  };
  generationSettings: {
    maxSteps: number;
    budgetLimitDollars: number;
  };
  executionPolicy: Record<ArmName, ExecutionPolicySnapshot>;
  redactedConfigSnapshot: Record<string, unknown>;
  schedule: ScheduledRun[];
}

export interface RunDurationsMs {
  setupMs: number;
  agentMs: number;
  verifyMs: number;
  cleanupMs: number;
  wallClockMs: number;
}

export interface RequestUsageTrace {
  turn: number;
  usage: NormalizedUsage;
  cost: CostCalculation;
}

export interface RunTraceArtifact {
  schemaVersion: string;
  experimentId: string;
  runId: string;
  arm: ArmName;
  caseId: string;
  trial: number;
  pairOrder: 'AB' | 'BA';
  durationsMs: RunDurationsMs;
  requests: RequestUsageTrace[];
  toolCalls: ToolTraceEntry[];
  actualFilesChanged: string[];
  diffBytes: number;
  diffTruncated: boolean;
}

export interface RunRecord {
  schemaVersion: string;
  experimentId: string;
  runId: string;
  trial: number;
  caseId: string;
  arm: ArmName;
  pairOrder: 'AB' | 'BA';
  mode: BenchmarkMode;
  recordedAt: string;
  status: string;
  agentStatus: AgentStatus;
  infraError?: string;
  error?: string;
  verified: IndependentVerification;
  durationsMs: RunDurationsMs;
  wallClockMs: number;
  llmTurns: number;
  toolCallsTotal: number;
  toolFailures: number;
  commandNonZeroExits: number;
  commandTimeouts: number;
  toolOutputBytesTotal: number;
  toolErrors: Array<{ name: string; error: string }>;
  toolCallsByName: Record<string, { total: number; failures: number; nonZeroExits: number }>;
  usage: NormalizedUsage;
  costDollars: number | null;
  costKind: 'estimated' | 'unpriced';
  pricingCanonicalId: string;
  filesChangedAgent: string[];
  filesChangedActual: string[];
  tracePath: string;
  patchPath: string;
}

/** Mulberry32 deterministic PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildExperimentSchedule(
  cases: readonly string[],
  trials: number,
  seed: number,
): ScheduledRun[] {
  const rng = mulberry32(seed);
  const schedule: ScheduledRun[] = [];

  for (let t = 0; t < trials; t++) {
    const shuffled = [...cases];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    for (let c = 0; c < shuffled.length; c++) {
      const caseId = shuffled[c]!;
      const pairOrder: 'AB' | 'BA' = (t + c) % 2 === 0 ? 'AB' : 'BA';
      const arms: readonly ArmName[] = pairOrder === 'AB' ? ['A_baseline', 'B_ms'] : ['B_ms', 'A_baseline'];
      for (const arm of arms) {
        schedule.push({
          runId: `trial-${t + 1}__${caseId}__${arm}`,
          trial: t + 1,
          caseId,
          arm,
          pairOrder,
          caseOrderIndex: c,
        });
      }
    }
  }
  return schedule;
}

export function sha256File(filePath: string): string {
  if (!fs.existsSync(filePath)) return 'missing';
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function sha256Directory(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return 'missing';
  const hash = crypto.createHash('sha256');
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(dirPath, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`F:${rel}\n`);
        hash.update(fs.readFileSync(full));
        hash.update('\n');
      }
    }
  };
  walk(dirPath);
  return hash.digest('hex');
}

export function getGitProvenance(repoDir: string): GitProvenance {
  const head = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  const commit = head.status === 0 ? head.stdout.trim() : 'unknown';
  const status = spawnSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
  const dirtyText = status.status === 0 ? status.stdout.trim() : '';
  const dirty = dirtyText.length > 0;
  let dirtyHash: string | null = null;
  if (dirty) {
    const diff = spawnSync('git', ['-C', repoDir, 'diff', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
    dirtyHash = crypto
      .createHash('sha256')
      .update(dirtyText + '\n' + (diff.stdout ?? ''))
      .digest('hex');
  }
  return { commit, dirty, dirtyHash };
}

export function redactConfigObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactConfigObject);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_NAME.test(k)) {
      out[k] = '‹redacted›';
    } else {
      out[k] = redactConfigObject(v);
    }
  }
  return out;
}

function listWorkspaceFiles(root: string): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return map;
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        map.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return map;
}

export function computeWorkspaceDiff(
  fixtureDir: string,
  workspaceDir: string,
  maxBytes = 256 * 1024,
): { filesChanged: string[]; diffText: string; diffBytes: number; truncated: boolean } {
  const baseFiles = listWorkspaceFiles(fixtureDir);
  const workFiles = listWorkspaceFiles(workspaceDir);
  const allPaths = Array.from(new Set([...baseFiles.keys(), ...workFiles.keys()])).sort();
  const filesChanged: string[] = [];

  for (const rel of allPaths) {
    const a = baseFiles.get(rel);
    const b = workFiles.get(rel);
    if (!a || !b || !a.equals(b)) {
      filesChanged.push(rel);
    }
  }

  let rawDiff = '';
  if (filesChanged.length > 0) {
    const diffRes = spawnSync(
      'diff',
      ['-ruN', '--exclude=__pycache__', '--exclude=.pytest_cache', '--exclude=.git', fixtureDir, workspaceDir],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: maxBytes * 4 },
    );
    if (diffRes.stdout) {
      rawDiff = diffRes.stdout
        .split(fixtureDir)
        .join('a')
        .split(workspaceDir)
        .join('b');
    } else {
      // Fallback if `diff` is unavailable
      rawDiff = filesChanged.map((f) => `changed: ${f}`).join('\n');
    }
  }

  const redacted = redact(rawDiff);
  const totalBytes = Buffer.byteLength(redacted, 'utf8');
  if (totalBytes <= maxBytes) {
    return { filesChanged, diffText: redacted, diffBytes: totalBytes, truncated: false };
  }
  const truncatedText = Buffer.from(redacted, 'utf8').subarray(0, maxBytes).toString('utf8') +
    `\n\n[NOTE: diff truncated at ${maxBytes} bytes (${totalBytes} bytes total)]\n`;
  return {
    filesChanged,
    diffText: truncatedText,
    diffBytes: totalBytes,
    truncated: true,
  };
}

export function loadRunRecords(jsonlPath: string): RunRecord[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const records: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as RunRecord);
  }
  return records;
}

export function loadCompletedRunIds(jsonlPath: string): Set<string> {
  return new Set(loadRunRecords(jsonlPath).map((r) => r.runId));
}

export function appendRunRecord(jsonlPath: string, record: RunRecord): void {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
}

export interface ArmSummary {
  attempted: number;
  verifiedSuccess: number;
  targetFixed: number;
  noRegressions: number;
  infraErrors: number;
  timeouts: number;
  totalWallClockMs: number;
  totalLlmTurns: number;
  totalToolCalls: number;
  totalToolFailures: number;
  totalCommandNonZeroExits: number;
  totalCommandTimeouts: number;
  totalToolOutputBytes: number;
  totalUncachedInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostDollars: number | null;
  costPerAttemptedTask: number | null;
  costPerVerifiedSuccess: number | null;
}

export interface ExperimentSummary {
  schemaVersion: string;
  experimentId: string;
  generatedAt: string;
  totalRuns: number;
  mode: BenchmarkMode;
  seed: number;
  trials: number;
  byArm: Record<ArmName, ArmSummary>;
  pairedDeltasByCase: Record<
    string,
    {
      pairs: number;
      passDeltaBMinusA: number;
      wallClockMsMedianDeltaBMinusA: number | null;
      costDollarsMedianDeltaBMinusA: number | null;
      turnsMedianDeltaBMinusA: number | null;
    }
  >;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function aggregateExperimentSummary(
  runs: readonly RunRecord[],
  manifest: Pick<ExperimentManifest, 'experimentId' | 'mode' | 'seed' | 'trials' | 'cases'>,
): ExperimentSummary {
  const summarizeArm = (arm: ArmName): ArmSummary => {
    const armRuns = runs.filter((r) => r.arm === arm);
    const attempted = armRuns.length;
    const verifiedSuccess = armRuns.filter((r) => r.verified.overallPassed).length;
    const pricedRuns = armRuns.filter((r) => r.costDollars !== null && r.costKind !== 'unpriced');
    const allUnpriced = attempted > 0 && pricedRuns.length === 0;
    const totalCostDollars = allUnpriced
      ? null
      : Number(pricedRuns.reduce((s, r) => s + (r.costDollars ?? 0), 0).toFixed(6));
    return {
      attempted,
      verifiedSuccess,
      targetFixed: armRuns.filter((r) => r.verified.targetFixed).length,
      noRegressions: armRuns.filter((r) => r.verified.noRegressions).length,
      infraErrors: armRuns.filter((r) => Boolean(r.infraError) || r.agentStatus === 'error').length,
      timeouts: armRuns.filter((r) => r.agentStatus === 'timeout').length,
      totalWallClockMs: Number(armRuns.reduce((s, r) => s + r.wallClockMs, 0).toFixed(2)),
      totalLlmTurns: armRuns.reduce((s, r) => s + r.llmTurns, 0),
      totalToolCalls: armRuns.reduce((s, r) => s + r.toolCallsTotal, 0),
      totalToolFailures: armRuns.reduce((s, r) => s + r.toolFailures, 0),
      totalCommandNonZeroExits: armRuns.reduce((s, r) => s + r.commandNonZeroExits, 0),
      totalCommandTimeouts: armRuns.reduce((s, r) => s + r.commandTimeouts, 0),
      totalToolOutputBytes: armRuns.reduce((s, r) => s + r.toolOutputBytesTotal, 0),
      totalUncachedInputTokens: armRuns.reduce((s, r) => s + r.usage.uncachedInput, 0),
      totalCacheReadTokens: armRuns.reduce((s, r) => s + r.usage.cacheRead, 0),
      totalCacheWriteTokens: armRuns.reduce((s, r) => s + r.usage.cacheWrite, 0),
      totalOutputTokens: armRuns.reduce((s, r) => s + r.usage.output, 0),
      totalTokens: armRuns.reduce((s, r) => s + r.usage.totalTokens, 0),
      totalCostDollars,
      costPerAttemptedTask:
        totalCostDollars !== null && attempted > 0 ? Number((totalCostDollars / attempted).toFixed(6)) : null,
      costPerVerifiedSuccess:
        totalCostDollars !== null && verifiedSuccess > 0 ? Number((totalCostDollars / verifiedSuccess).toFixed(6)) : null,
    };
  };

  const pairedDeltasByCase: ExperimentSummary['pairedDeltasByCase'] = {};
  for (const caseId of manifest.cases) {
    const caseRuns = runs.filter((r) => r.caseId === caseId);
    const trials = Array.from(new Set(caseRuns.map((r) => r.trial)));
    const wallDeltas: number[] = [];
    const costDeltas: number[] = [];
    const turnDeltas: number[] = [];
    let passDeltaSum = 0;
    let pairs = 0;

    for (const trial of trials) {
      const a = caseRuns.find((r) => r.trial === trial && r.arm === 'A_baseline');
      const b = caseRuns.find((r) => r.trial === trial && r.arm === 'B_ms');
      if (!a || !b) continue;
      pairs += 1;
      passDeltaSum += (b.verified.overallPassed ? 1 : 0) - (a.verified.overallPassed ? 1 : 0);
      wallDeltas.push(b.wallClockMs - a.wallClockMs);
      if (a.costDollars !== null && b.costDollars !== null) {
        costDeltas.push(Number((b.costDollars - a.costDollars).toFixed(6)));
      }
      turnDeltas.push(b.llmTurns - a.llmTurns);
    }

    pairedDeltasByCase[caseId] = {
      pairs,
      passDeltaBMinusA: passDeltaSum,
      wallClockMsMedianDeltaBMinusA: median(wallDeltas),
      costDollarsMedianDeltaBMinusA: median(costDeltas),
      turnsMedianDeltaBMinusA: median(turnDeltas),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    experimentId: manifest.experimentId,
    generatedAt: new Date().toISOString(),
    totalRuns: runs.length,
    mode: manifest.mode,
    seed: manifest.seed,
    trials: manifest.trials,
    byArm: {
      A_baseline: summarizeArm('A_baseline'),
      B_ms: summarizeArm('B_ms'),
    },
    pairedDeltasByCase,
  };
}
