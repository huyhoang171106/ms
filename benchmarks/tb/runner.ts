/**
 * Runs one Axiom agent arm inside a Terminal-Bench container (bundled by build.sh, launched by harbor_agent.py).
 *   A_eight  Axiom's default tools          B_one  single `ms` code-mode tool (directExec)
 *   C_py     single persistent CPython REPL (integrations/axiom/cpy.ts; Unharnessed / prime-agent shape)
 *   B_repl   integrations/axiom python_repl (sh/patch/lint helpers + batching workflow), unsandboxed: the container is the sandbox
 * Usage and per-call traces are rewritten to --out after every tool call, so a harbor timeout still leaves numbers.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../../../nhom-30/axiom-cli/src/core/agent-loop.js';
import { DEFAULT_CONFIG, loadConfig } from '../../../nhom-30/axiom-cli/src/core/config.js';
import { EventBus } from '../../../nhom-30/axiom-cli/src/core/event-bus.js';
import { SessionManager } from '../../../nhom-30/axiom-cli/src/core/session.js';
import type { TokenUsage } from '../../../nhom-30/axiom-cli/src/core/types.js';
import { loadCatalog } from '../../../nhom-30/axiom-cli/src/llm/catalog/index.js';
import { CostTracker } from '../../../nhom-30/axiom-cli/src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../../../nhom-30/axiom-cli/src/llm/model-resolver.js';
import type { BaseTool } from '../../../nhom-30/axiom-cli/src/tools/base-tool.js';
import { ToolRegistry } from '../../../nhom-30/axiom-cli/src/tools/registry.js';
import { buildMsSystemPrompt, createMsTool } from '../../integrations/axiom/ms-tool.js';
import { PYTHON_REPL_WORKFLOW, buildPythonReplPrompt, createPythonRepl, hostPython } from '../../integrations/axiom/python-repl.js';
import { responsesReplayFetch, stallGuardFetch } from '../../integrations/axiom/responses-replay.js';
import { PYTHON_SYSTEM, admitsGap, createCpyGate, createPythonTool, looksFailed } from '../../integrations/axiom/cpy.js';

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};
const arm = arg('arm');
const model = arg('model');
const workspace = arg('workspace', '/app');
const outFile = arg('out');
const abx = arg('abx', '/opt/abx');
const maxSteps = Number(arg('max-steps', '150'));
const instruction = fs.readFileSync(arg('instruction'), 'utf8');

function buildArm(): { registry: ToolRegistry; system: string; close: () => Promise<void> } {
  if (arm === 'A_eight') {
    const registry = new ToolRegistry();
    registry.allowWithoutApprover = true;
    return { registry, system: DEFAULT_SYSTEM_PROMPT, close: async () => {} };
  }
  if (arm === 'B_one') {
    const registry = new ToolRegistry(['ms']);
    registry.allowWithoutApprover = true;
    const stateDir = path.join(abx, 'ms-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const tool = createMsTool({
      msBin: path.join(abx, 'ms'), workspaceRoot: workspace, stateDir, allowWrite: true, allowUnapprovedWrites: true,
      directExec: true, limits: { timeoutMs: 900_000, maxCalls: 512 },
    });
    registry.registerTool(tool as unknown as BaseTool);
    const system = buildMsSystemPrompt(DEFAULT_SYSTEM_PROMPT)
      .replace('Shell runs on a snapshot, so persist with the file API.', 'Shell runs in the workspace and its effects persist; the file API is confined to the workspace root.');
    return { registry, system, close: () => tool.close() };
  }
  if (arm === 'C_py') {
    const registry = new ToolRegistry(['python']);
    registry.allowWithoutApprover = true;
    const tool = createPythonTool({ python: path.join(abx, 'python/bin/python3'), kernel: path.join(abx, 'cpy_kernel.py'), cwd: workspace, timeoutMs: 900_000 });
    registry.registerTool(tool as unknown as BaseTool);
    return { registry, system: PYTHON_SYSTEM.replace('{cwd}', workspace), close: () => tool.close() };
  }
  if (arm === 'B_repl') {
    const registry = new ToolRegistry(['python_repl']);
    registry.allowWithoutApprover = true;
    const tool = createPythonRepl(workspace, path.join(abx, 'repl-state'), { timeoutMs: 900_000, host: { python: hostPython(path.join(abx, 'python/bin/python3')) } });
    registry.registerTool(tool as unknown as BaseTool);
    // MS_REPL_BATCH_PROMPT is baked in at bundle time by build.sh (the container has no host env).
    const workflow = process.env.MS_REPL_BATCH_PROMPT === '0' ? '' : `\n\n${PYTHON_REPL_WORKFLOW}`;
    return { registry, system: `${buildPythonReplPrompt(DEFAULT_SYSTEM_PROMPT)}${workflow}`, close: () => tool.close() };
  }
  throw new Error(`unknown arm ${arm}`);
}

const usage = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const record = {
  arm, model, status: 'running', error: undefined as string | undefined,
  llmTurns: 0, toolCalls: 0, toolFailures: 0, toolOutputBytes: 0, usage, wallMs: 0,
  assistant: [] as Array<{ turn: number; toolCalls: number; text: string }>,
  traces: [] as Array<{ turn: number; name: string; isError: boolean; bytes: number; args: string; output: string }>,
};
const started = performance.now();
const flush = () => {
  record.wallMs = Math.round(performance.now() - started);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
};

const bus = new EventBus();
const pending = new Map<string, unknown>();
bus.on('cost_update', (u: TokenUsage) => {
  usage.prompt += u.promptTokens ?? 0;
  usage.completion += u.completionTokens ?? 0;
  usage.cacheRead += u.cacheReadInputTokens ?? 0;
  usage.cacheWrite += u.cacheCreationInputTokens ?? 0;
  usage.total += u.totalTokens ?? 0;
  flush();
});
bus.on('tool_call_start', (tc: { id: string; arguments: unknown }) => pending.set(tc.id, tc.arguments));
// B_repl completion gate: the last tool result decides whether a stop needs the reminder turn.
let lastCheckPassed = false;
// AgentLoop also calls isComplete() right after tools run (and ends the run if true), so only answer true right after a model reply.
let sinceChat = false;
const gate = createCpyGate({ trim: process.env.MS_CPY_TRIM !== '0', onExtraTurn: () => { record.llmTurns++; } });
bus.on('tool_call_end', (r: { toolCallId?: string; name?: string; output: string; isError?: boolean }) => {
  const output = String(r.output ?? '');
  lastCheckPassed = !looksFailed(output, r.isError === true);
  sinceChat = false;
  gate.toolEnded(output, r.isError === true);
  const bytes = Buffer.byteLength(output);
  record.toolCalls++;
  record.toolOutputBytes += bytes;
  if (r.isError) record.toolFailures++;
  record.traces.push({
    turn: record.llmTurns, name: r.name ?? 'unknown', isError: r.isError === true, bytes,
    args: JSON.stringify(pending.get(r.toolCallId ?? '') ?? null).slice(0, 40_000), output: output.slice(0, 1500),
  });
  flush();
});

const { registry, system, close } = buildArm();
try {
  const config = loadConfig();
  const catalog = loadCatalog();
  const modelInfo = (() => {
    try {
      return resolveModel(model, catalog, config);
    } catch (err) {
      const slash = model.indexOf('/');
      const first = slash > 0 ? catalog.models(model.slice(0, slash))[0] : undefined;
      if (!first) throw err;
      const id = model.slice(slash + 1);
      return { ...resolveModel(`${model.slice(0, slash)}/${first.id}`, catalog, config), id, name: id };
    }
  })();
  // MS_CPY_REASONING is baked in by build.sh: replay reasoning + prompt_cache_key + low verbosity on Responses routes (as pi/codex do).
  globalThis.fetch = stallGuardFetch(globalThis.fetch, 120_000);
  if (arm === 'C_py' && process.env.MS_CPY_REASONING !== '0') globalThis.fetch = responsesReplayFetch(globalThis.fetch, { cacheKey: randomUUID() });
  const raw = await createProviderFor(modelInfo);
  const provider = Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, {
    chat: async (params: Parameters<typeof raw.chat>[0]) => {
      record.llmTurns++;
      if (arm === 'C_py') return gate.chat(params, (p) => raw.chat(p));
      // tb21-luna-lean10 cobol: one run died on a spurious "flagged as potentially violating" stream error; pi/codex retry those.
      const res = await raw.chat(params).catch((err: unknown) => { if (/flagged as potentially violating/i.test(String(err))) return raw.chat(params); throw err; });
      sinceChat = true; if (!res.toolCalls?.length && admitsGap(res.content ?? '')) lastCheckPassed = false;
      return res;
    },
  });
  const env = [
    'Environment:',
    `- You are root in a Linux container; the working directory is ${workspace}. Installing packages and changing system files is allowed.`,
    '- No user is watching: never ask questions, finish the task completely. Hidden tests check the final state of the container after you stop.',
    '- Replying without a tool call ends the run for good. Never stop while a build, test or check you ran is failing: read the error, fix it, rerun. Only stop once the requested result exists and you have verified it.',
  ].join('\n');
  const loop = new AgentLoop({
    config: { ...DEFAULT_CONFIG, workspaceRoot: workspace },
    provider,
    model: modelInfo.id,
    toolRegistry: registry,
    sessionManager: new SessionManager({ workspaceRoot: workspace, sessionsDir: path.join(abx, 'sessions'), autoSave: false }),
    costTracker: new CostTracker(),
    eventBus: bus,
    systemPrompt: arm === 'C_py' ? system : `${system}\n\n${env}`,  // C_py's spec carries its own env lines
    maxTokens: modelInfo.maxTokens ?? 32768,
    maxSteps,
    budgetLimitDollars: 20,
    // One nudge the first time the model stops: Luna otherwise ends on "I couldn't verify it" status reports.
    // B_repl: a stop right after a passing tool result is accepted; otherwise one reminder. Other arms: always one reminder.
    // Traces: B_repl resumed after the reminder in 1/18 runs (tb21-haiku-all10); useful resumes followed a failing output.
    // C_py always gets the one reminder: tb21-luna-lean10 cobol 0/3 stopped after a passing check that only ran the given input (one branch).
    // C_py skips the reminder only when it stops on a passing test suite: lean19-22, 12/12 such stops (fix-vuln "All 367 tests pass")
    // made no edit after the reminder, which only cost 1-3 full-context turns. Stops on weaker evidence (syntax compile, one input) still get it.
    isComplete: () => (arm === 'C_py' ? gate.isComplete() : arm === 'B_repl' && sinceChat && lastCheckPassed),
    completionReminder: arm === 'C_py'
      ? gate.reminder
      : 'You stopped. If anything you were asked to produce is missing or unverified, or a build/test you ran still fails, continue with tool calls now. Otherwise reply with a one-line final summary.',
  });
  const task = await loop.runTask(instruction).finally(() => {
    record.assistant = loop.transcript().filter((m) => m.role === 'assistant')
      .map((m, i) => ({ turn: i + 1, toolCalls: m.toolCalls?.length ?? 0, text: String(m.content ?? '').slice(0, 3000) }));
  });
  record.status = task.status;
  if (task.error) record.error = String(task.error).slice(0, 2000);
} catch (caught) {
  record.status = 'error';
  record.error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await close();
  flush();
}
process.exit(0);
