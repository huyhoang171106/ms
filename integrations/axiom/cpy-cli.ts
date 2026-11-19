#!/usr/bin/env bun
/**
 * EXPERIMENTAL: run an Axiom agent whose only tool is C_py (one persistent CPython REPL with `bash()`), with the same chat
 * gate as the Terminal-Bench C_py arm. Interface, prompt and defaults may change without notice.
 *
 *   bun integrations/axiom/cpy-cli.ts [--model openai-codex/gpt-6-luna] [--effort medium] [--cwd DIR] [--max-steps 150] "task"
 *   echo "task" | bun integrations/axiom/cpy-cli.ts
 *
 * Model code runs UNSANDBOXED as the current user in --cwd. Axiom is loaded from AXIOM_CLI_DIR (default: ../nhom-30/axiom-cli
 * next to this repo) and uses its logins (~/.axiom/auth.json). Progress goes to stderr, the final reply to stdout;
 * exit 0 when the run completed, 1 otherwise.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PYTHON_SYSTEM, createCpyGate, createPythonTool } from './cpy.js';
import { responsesReplayFetch, sessionCacheFetch, stallGuardFetch } from './responses-replay.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: 'openai-codex/gpt-6-luna' },
    effort: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    'max-steps': { type: 'string', default: '150' },
    replay: { type: 'boolean' },
    python: { type: 'string', default: 'python3' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log('EXPERIMENTAL. Usage: cpy-cli.ts [--model ID] [--effort off|minimal|low|medium|high|xhigh] [--cwd DIR] [--max-steps N] [--python BIN] [--replay] "task" (or task on stdin)');
  process.exit(0);
}
const task = (positionals.join(' ') || (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'))).trim();
if (!task) {
  console.error('cpy-cli: no task (pass it as an argument or on stdin); --help for usage');
  process.exit(2);
}
const maxSteps = Number(values['max-steps']);
if (!Number.isInteger(maxSteps) || maxSteps < 1) {
  console.error(`cpy-cli: --max-steps must be a positive integer, got ${values['max-steps']}`);
  process.exit(2);
}
const cwd = path.resolve(values.cwd);
if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`cpy-cli: --cwd ${cwd} is not a directory`);
  process.exit(2);
}
// Read by Axiom's providers when the request is built.
// Opt-in: replay reasoning across turns, one prompt_cache_key per run, low verbosity (responses-replay.ts). No measured gain on TB (lean33 vs lean34).
globalThis.fetch = stallGuardFetch(globalThis.fetch, 120_000);
globalThis.fetch = sessionCacheFetch(globalThis.fetch, randomUUID());
if (values.replay) globalThis.fetch = responsesReplayFetch(globalThis.fetch, { cacheKey: randomUUID() });

const axiomDir = path.resolve(process.env.AXIOM_CLI_DIR ?? path.join(import.meta.dirname, '../../../nhom-30/axiom-cli'));
const ax = (rel: string) => import(path.join(axiomDir, 'src', rel));
const [{ AgentLoop }, { DEFAULT_CONFIG, loadConfig }, { EventBus }, { SessionManager }, { loadCatalog }, { CostTracker }, { createProviderFor, resolveModel }, { ToolRegistry }] =
  await Promise.all(['core/agent-loop.ts', 'core/config.ts', 'core/event-bus.ts', 'core/session.ts', 'llm/catalog/index.ts', 'llm/cost-tracker.ts', 'llm/model-resolver.ts', 'tools/registry.ts'].map(ax))
    .catch((err: unknown) => { console.error(`cpy-cli: cannot load Axiom from ${axiomDir} (set AXIOM_CLI_DIR): ${err}`); process.exit(2); });

// The benchmark spec says "root, Linux container"; on a host the agent is the user and must not touch the system.
const role = 'role: autonomous SWE agent. root, Linux container, cwd={cwd}. installs ok.';
const user = 'user: absent. never ask. hidden tests grade final container state.';
if (!PYTHON_SYSTEM.includes(role) || !PYTHON_SYSTEM.includes(user)) throw new Error('PYTHON_SYSTEM changed: update cpy-cli.ts');
const system = PYTHON_SYSTEM
  .replace(role, "role: autonomous SWE agent on the user's machine as the user, cwd={cwd}. no sudo, no system-wide installs.")
  .replace(user, 'user: absent until the run ends. never ask. finish the task and verify it.')
  .replace('{cwd}', cwd);

console.error('\x1b[33m[cpy] EXPERIMENTAL: model-written Python and shell run unsandboxed as you in', cwd, '\x1b[0m');

const tool = createPythonTool({ python: values.python, kernel: path.join(import.meta.dirname, 'cpy_kernel.py'), cwd, timeoutMs: 900_000 });
const registry = new ToolRegistry(['python']);
registry.allowWithoutApprover = true;
registry.registerTool(tool);

const usage = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 };
const bus = new EventBus();
const gate = createCpyGate();
bus.on('cost_update', (u: Record<string, number | undefined>) => {
  usage.prompt += u.promptTokens ?? 0;
  usage.completion += u.completionTokens ?? 0;
  usage.cacheRead += u.cacheReadInputTokens ?? 0;
  usage.cacheWrite += u.cacheCreationInputTokens ?? 0;
});
const head = (s: string, n: number) => s.split('\n').slice(0, n).join('\n  ');
bus.on('tool_call_start', (tc: { arguments?: { code?: unknown } }) => console.error(`\x1b[36m▶ python\x1b[0m\n  ${head(String(tc.arguments?.code ?? ''), 6)}`));
bus.on('tool_call_end', (r: { output?: unknown; isError?: boolean }) => {
  const output = String(r.output ?? '');
  gate.toolEnded(output, r.isError === true);
  console.error(`\x1b[2m  ${head(output, 4)}\x1b[0m`);
});

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpy-cli-'));
const close = async () => { await tool.close(); fs.rmSync(sessionsDir, { recursive: true, force: true }); };
process.on('SIGINT', () => { void close().finally(() => process.exit(130)); });

let code = 1;
try {
  const config = loadConfig();
  // Axiom reads the thinking level from the selector suffix (`openai-codex/gpt-6-luna:medium`).
  const modelInfo = resolveModel(values.effort ? `${values.model}:${values.effort}` : values.model, loadCatalog(), config);
  const raw = await createProviderFor(modelInfo);
  const provider = Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, {
    chat: (params: { messages: Array<{ role: string; content: string }> }) => gate.chat(params, (p) => raw.chat(p)),
  });
  const loop = new AgentLoop({
    config: { ...DEFAULT_CONFIG, workspaceRoot: cwd },
    provider,
    model: modelInfo.id,
    toolRegistry: registry,
    sessionManager: new SessionManager({ workspaceRoot: cwd, sessionsDir, autoSave: false }),
    costTracker: new CostTracker(),
    eventBus: bus,
    systemPrompt: system,
    maxTokens: modelInfo.maxTokens ?? 32768,
    maxSteps,
    budgetLimitDollars: 20,
    isComplete: gate.isComplete,
    completionReminder: gate.reminder,
  });
  const result = await loop.runTask(task);
  const last = loop.transcript().filter((m: { role: string }) => m.role === 'assistant').at(-1);
  if (last?.content) console.log(String(last.content));
  if (result.error) console.error(`cpy-cli: ${result.error}`);
  console.error(`[cpy] ${result.status}; tokens prompt ${usage.prompt} (cache read ${usage.cacheRead}, write ${usage.cacheWrite}) completion ${usage.completion}`);
  code = result.status === 'completed' ? 0 : 1;
} catch (err) {
  console.error(`cpy-cli: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await close();
}
process.exit(code);
