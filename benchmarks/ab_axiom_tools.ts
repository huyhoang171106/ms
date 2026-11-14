import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { pythonBin } from '../../nhom-30/src/core/paths.js';
import { redact, scrubEnv } from '../../nhom-30/src/core/secrets.js';
import { PYTEST_ARGS, TEST_TIMEOUT_MS } from '../../nhom-30/src/core/verifier.js';
import { BaseTool, type ToolExecutionContext } from '../../nhom-30/src/tools/base-tool.js';
import { destructiveReason } from '../../nhom-30/src/tools/bash.js';
import { escapesWorkspace } from '../../nhom-30/src/tools/permissions.js';
import { ToolRegistry } from '../../nhom-30/src/tools/registry.js';
import {
  bwrapInvocation,
  extraWritableFromEnv,
  planSandbox,
  type SandboxPlan,
} from '../../nhom-30/src/tools/sandbox.js';
import { MsAxiomAdapter, type EditSpec } from '../examples/axiom_adapter.js';

export type BenchmarkMode = 'controlled' | 'native';

export const CONTROLLED_TIMEOUT_MS = TEST_TIMEOUT_MS; // 120_000 ms, matching BashTool & runPytest

export interface ExecutionPolicySnapshot {
  mode: BenchmarkMode;
  arm: 'A_baseline' | 'B_ms';
  shell: string;
  pythonBin: string;
  timeoutMs: number;
  envScrubbed: boolean;
  sandboxKind: SandboxPlan['kind'];
  sandboxDetail: string;
  targetValidation: boolean;
  destructiveGuard: boolean;
  allowWithoutApprover: boolean;
  walAndOpenat2Scope: string;
}

export interface ToolTraceEntry {
  toolCallId: string;
  name: string;
  startedAtMonoMs: number;
  durationMs: number;
  isError: boolean;
  toolOutputBytes: number;
  exitCode: number | null;
  timedOut: boolean;
  errorPreview?: string;
}

export function getExecutionPolicySnapshot(
  mode: BenchmarkMode,
  arm: 'A_baseline' | 'B_ms',
  sandboxPlan: SandboxPlan = planSandbox(),
): ExecutionPolicySnapshot {
  if (mode === 'controlled' || arm === 'A_baseline') {
    return {
      mode,
      arm,
      shell: '/bin/bash',
      pythonBin: pythonBin(),
      timeoutMs: CONTROLLED_TIMEOUT_MS,
      envScrubbed: true,
      sandboxKind: sandboxPlan.kind,
      sandboxDetail: sandboxPlan.detail,
      targetValidation: true,
      destructiveGuard: true,
      allowWithoutApprover: true,
      walAndOpenat2Scope:
        arm === 'B_ms'
          ? 'ms RPC file operations only (read, edit, write_file, delete_file, rename_file, tx.undo); arbitrary shell commands via run_command/ms exec bypass WAL/openat2/test-guard'
          : 'none (standard filesystem tools)',
    };
  }

  return {
    mode: 'native',
    arm: 'B_ms',
    shell: 'sh (heuristic in ms exec)',
    pythonBin: 'python3',
    timeoutMs: 60_000,
    envScrubbed: false,
    sandboxKind: 'local',
    sandboxDetail: 'ms exec direct child process',
    targetValidation: false,
    destructiveGuard: false,
    allowWithoutApprover: true,
    walAndOpenat2Scope:
      'ms RPC file operations only (read, edit, write_file, delete_file, rename_file, tx.undo); arbitrary shell commands via run_command/ms exec bypass WAL/openat2/test-guard',
  };
}

export function validatePytestTarget(root: string, target: string): string {
  const trimmed = target.trim();
  const file = trimmed.split('::')[0] ?? '';
  if (!trimmed || trimmed.startsWith('-')) {
    throw new Error(`invalid test target "${target}"`);
  }
  if (path.isAbsolute(file) || escapesWorkspace(file, root)) {
    throw new Error(`test target ${file} is outside the workspace`);
  }
  return trimmed;
}

const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

export function buildControlledExecInvocation(
  command: string,
  cwd: string,
  sandboxPlan: SandboxPlan = planSandbox(),
): { file: string; args: string[] } {
  return sandboxPlan.kind === 'bwrap'
    ? bwrapInvocation(command, cwd, { extraWritable: extraWritableFromEnv() })
    : { file: '/bin/bash', args: ['-c', command] };
}

export function buildControlledPytestInvocation(
  workspaceRoot: string,
  target: string | undefined,
  sandboxPlan: SandboxPlan = planSandbox(),
): { file: string; args: string[]; validatedTarget?: string } {
  const validatedTarget = target !== undefined ? validatePytestTarget(workspaceRoot, target) : undefined;
  const python = pythonBin();
  const argv = [python, ...PYTEST_ARGS, ...(validatedTarget ? [validatedTarget] : [])];
  if (sandboxPlan.kind === 'bwrap') {
    const inv = bwrapInvocation(`exec ${argv.map(shellQuote).join(' ')}`, workspaceRoot, {
      isolateNetwork: true,
      readableRoots: resolvePythonReadableRoots(python),
    });
    return { file: inv.file, args: inv.args, validatedTarget };
  }
  return { file: python, args: argv.slice(1), validatedTarget };
}

const pythonReadableRootsCache = new Map<string, string[]>();

function resolvePythonReadableRoots(python: string): string[] {
  const cached = pythonReadableRootsCache.get(python);
  if (cached) return cached;

  const roots = new Set<string>();
  roots.add(path.dirname(python));
  try {
    roots.add(path.dirname(fs.realpathSync(python)));
  } catch {
    // ignore
  }

  const probe = spawnSync(
    python,
    [
      '-I',
      '-c',
      "import os, site, sys; print(sys.prefix, sys.base_prefix, site.getusersitepackages(), os.path.dirname(os.path.realpath(sys.executable)), sep='\\n')",
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (probe.status === 0 && probe.stdout) {
    for (const line of probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      roots.add(line);
      try {
        roots.add(fs.realpathSync(line));
      } catch {
        // user site dir may not exist
      }
    }
  }

  for (const p of ['/usr', '/lib', '/lib64', '/etc', '/bin']) {
    if (fs.existsSync(p)) roots.add(p);
  }
  const result = [...roots].filter((r) => r !== '/');
  pythonReadableRootsCache.set(python, result);
  return result;
}

function toWorkspaceRel(filePath: string, context?: ToolExecutionContext): string {
  const trimmed = filePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || !context?.workspaceRoot) return trimmed;
  const realRoot = fs.realpathSync(context.workspaceRoot);
  return path.relative(realRoot, trimmed).split(path.sep).join('/');
}

function formatMsError(completed: { error?: { code: string; message: string; hint?: string } }): string {
  const err = completed.error;
  if (!err) return 'Error: ms operation failed';
  return `Error: ${err.code}: ${err.message}${err.hint ? ` (${err.hint})` : ''}`;
}

export function extractExitMetadata(toolName: string, output: string, isError: boolean): { exitCode: number | null; timedOut: boolean } {
  if (toolName !== 'run_command' && toolName !== 'run_tests') {
    return { exitCode: null, timedOut: false };
  }
  const timedOut = /\[TIMED OUT\b|timed out after|TIMEOUT after/i.test(output);
  if (timedOut) {
    const m = output.match(/exit:(\d+)/);
    return { exitCode: m ? Number(m[1]) : 124, timedOut: true };
  }
  const msHeader = output.match(/^\[(?:OK|FAILED)\s*\|\s*exit:(-?\d+)/m);
  if (msHeader) {
    return { exitCode: Number(msHeader[1]), timedOut: false };
  }
  const bashFooter = output.match(/\[exit code (-?\d+)\]\s*$/m);
  if (bashFooter) {
    return { exitCode: Number(bashFooter[1]), timedOut: false };
  }
  const pytestExit = output.match(/pytest exit code (-?\d+)/m);
  if (pytestExit) {
    return { exitCode: Number(pytestExit[1]), timedOut: false };
  }
  if (toolName === 'run_tests') {
    const counts = output.match(/^passed (\d+), failed (\d+), skipped (\d+), collection errors (\d+)/m);
    if (counts) {
      const failed = Number(counts[2]);
      const errors = Number(counts[4]);
      if (errors > 0) return { exitCode: 2, timedOut: false };
      return { exitCode: failed > 0 ? 1 : 0, timedOut: false };
    }
  }
  if (!isError) {
    return { exitCode: 0, timedOut: false };
  }
  return { exitCode: 1, timedOut: false };
}

function execViaMsDistill(
  msBin: string,
  workspaceRoot: string,
  cmdArgs: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ exitCode: number; output: string }> {
  const args = ['exec', '--root', workspaceRoot, '--timeout', String(opts.timeoutMs), '--', ...cmdArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(msBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? 1, output: (out || err).trimEnd() });
    });
  });
}

class MsReadTool extends BaseTool {
  readonly name = 'read_file';
  readonly isReadOnly = true;
  readonly description =
    'Read file contents in compact hashline format (`line:tag| text`) with file revision header (`rev:...`). Use line:tag or lineRange when editing with `edit`.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to read' },
      offset: { type: 'number', description: '1-based starting line number (default 1)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default 200)' },
      lineRange: { type: 'string', description: 'Optional line range "start-end" (e.g. "10-50")' },
    },
    required: ['path'],
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = toWorkspaceRel(typeof args.path === 'string' ? args.path : '', context);
    if (!filePath) return 'Error: path is required';
    let startLine = typeof args.offset === 'number' && args.offset >= 1 ? Math.floor(args.offset) : 1;
    let lineCount = typeof args.limit === 'number' && args.limit >= 1 ? Math.floor(args.limit) : 200;
    if (typeof args.lineRange === 'string' && args.lineRange.trim()) {
      const m = args.lineRange.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (m) {
        startLine = Math.max(1, Number(m[1]));
        const endLine = m[2] ? Math.max(startLine, Number(m[2])) : startLine;
        lineCount = endLine - startLine + 1;
      }
    }
    const { completed } = await this.ms.readFile(this.sessionId, filePath, startLine, lineCount, { format: 'hashline' });
    if (completed.status !== 'ok' || !completed.result) return formatMsError(completed);
    const res = completed.result as { hashline?: string };
    return res.hashline ?? '';
  }
}

class MsListTool extends BaseTool {
  readonly name = 'list_dir';
  readonly isReadOnly = true;
  readonly description = 'List files and directories in the workspace.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default ".")' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories (default true)' },
      maxEntries: { type: 'number', description: 'Maximum entries to return (default 200)' },
    },
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const rawPath = typeof args.path === 'string' ? toWorkspaceRel(args.path, context) : '';
    const dirPath = rawPath && rawPath !== '.' ? rawPath : undefined;
    const recursive = typeof args.recursive === 'boolean' ? args.recursive : true;
    const maxEntries = typeof args.maxEntries === 'number' ? Math.floor(args.maxEntries) : 200;
    const { records, completed } = await (this.ms as unknown as {
      sendRequest: (
        m: string,
        p: Record<string, unknown>,
      ) => Promise<{
        records: unknown[];
        completed: { status: string; error?: { code: string; message: string; hint?: string } };
      }>;
    }).sendRequest('call', {
      sessionId: this.sessionId,
      operation: { kind: 'list', path: dirPath, recursive, maxEntries },
    });
    if (completed.status !== 'ok') return formatMsError(completed);
    const entries = records as Array<{ kind: string; path: string }>;
    if (!entries.length) return '(empty directory)';
    return entries.map((e) => (e.kind === 'dir' ? `${e.path}/` : e.path)).join('\n');
  }
}

class MsSearchTool extends BaseTool {
  readonly name = 'search_code';
  readonly isReadOnly = true;
  readonly description =
    'Search workspace file contents. Returns `path:line:tag| text` with hashline tags ready for `edit`.';
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search query or regex' },
      path: { type: 'string', description: 'Optional file or directory to search' },
      regex: { type: 'boolean', description: 'Treat pattern as regex (default true)' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default true)' },
      maxResults: { type: 'number', description: 'Maximum matches (default 50)' },
    },
    required: ['pattern'],
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern) return 'Error: pattern must be a non-empty string';
    const rawPath = typeof args.path === 'string' ? toWorkspaceRel(args.path, context) : '';
    const searchPath = rawPath && rawPath !== '.' ? rawPath : undefined;
    const regex = typeof args.regex === 'boolean' ? args.regex : true;
    const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : undefined;
    const maxMatches = typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 50;
    const { records, completed } = await this.ms.search(this.sessionId, pattern, {
      path: searchPath,
      regex,
      caseSensitive,
      maxMatches,
    });
    if (completed.status !== 'ok') return formatMsError(completed);
    const matches = records as Array<{ path: string; lineNumber: number; lineTag: string; lineText: string }>;
    if (!matches.length) return `No matches for /${pattern}/`;
    return matches.map((m) => `${m.path}:${m.lineNumber}:${m.lineTag}| ${m.lineText}`).join('\n');
  }
}

class MsEditTool extends BaseTool {
  readonly name = 'edit';
  readonly description =
    'Edit a file durably via `ms` RPC (WAL + openat2 + test-guard). Supports `edits` array, `oldText`+`newText`, or `startLine`+`endLine`+`replacement`.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to edit' },
      expectedRevision: { type: 'string', description: 'Optional BLAKE3 revision from read_file' },
      edits: {
        type: 'array',
        description: 'Array of edits: {startLine, endLine, startTag?, endTag?, replacement} or {oldText, newText}',
        items: { type: 'object' },
      },
      oldText: { type: 'string', description: 'Unique existing text to replace (shorthand for single edit)' },
      newText: { type: 'string', description: 'Replacement text (shorthand for single edit)' },
      startLine: { type: 'number', description: '1-based start line (shorthand for single hashline edit)' },
      endLine: { type: 'number', description: '1-based end line (shorthand for single hashline edit)' },
      startTag: { type: 'string', description: 'Optional 4-char hashline tag for startLine' },
      endTag: { type: 'string', description: 'Optional 4-char hashline tag for endLine' },
      replacement: { type: 'string', description: 'Replacement text for line-range edit' },
    },
    required: ['path'],
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = toWorkspaceRel(typeof args.path === 'string' ? args.path : '', context);
    if (!filePath) return 'Error: path is required';

    let edits: EditSpec[] = [];
    const rangeReplacement =
      typeof args.replacement === 'string'
        ? args.replacement
        : typeof args.newText === 'string' && typeof args.oldText !== 'string'
          ? args.newText
          : undefined;
    if (Array.isArray(args.edits) && args.edits.length > 0) {
      edits = args.edits as EditSpec[];
    } else if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
      edits = [{ oldText: args.oldText, newText: args.newText }];
    } else if (typeof args.startLine === 'number' && typeof args.endLine === 'number' && rangeReplacement !== undefined) {
      edits = [
        {
          startLine: args.startLine,
          endLine: args.endLine,
          ...(typeof args.startTag === 'string' ? { startTag: args.startTag } : {}),
          ...(typeof args.endTag === 'string' ? { endTag: args.endTag } : {}),
          replacement: rangeReplacement,
        },
      ];
    } else {
      return 'Error: provide either `edits`, `oldText`+`newText`, or `startLine`+`endLine`+`replacement`';
    }

    const opId = `op-${crypto.randomUUID()}`;
    const expectedRevision = typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined;
    const { completed } = await this.ms.editFile(this.sessionId, opId, filePath, edits, { expectedRevision });
    if (completed.status !== 'ok' || !completed.result) return formatMsError(completed);
    const res = completed.result as { newRevision?: string; transactionId?: string };
    return `Edited ${filePath} (rev:${res.newRevision ?? 'ok'}, tx:${res.transactionId ?? ''})`;
  }
}

class MsWriteTool extends BaseTool {
  readonly name = 'write_file';
  readonly description = 'Create or overwrite a file durably via `ms` RPC (WAL + openat2 + test-guard).';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      content: { type: 'string', description: 'Full file content' },
      overwrite: { type: 'boolean', description: 'Allow overwriting existing file (default true)' },
    },
    required: ['path', 'content'],
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = toWorkspaceRel(typeof args.path === 'string' ? args.path : '', context);
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (!filePath || content === undefined) return 'Error: path and content are required';
    const overwrite = typeof args.overwrite === 'boolean' ? args.overwrite : true;
    const opId = `op-${crypto.randomUUID()}`;
    const { completed } = await this.ms.writeFile(this.sessionId, opId, filePath, content, {
      createIfMissing: true,
      overwrite,
    });
    if (completed.status !== 'ok' || !completed.result) return formatMsError(completed);
    const res = completed.result as { newRevision?: string; transactionId?: string };
    return `Wrote ${filePath} (rev:${res.newRevision ?? 'ok'}, tx:${res.transactionId ?? ''})`;
  }
}

class MsExecTool extends BaseTool {
  readonly name = 'run_command';
  readonly description = 'Execute a shell command in the workspace via `ms exec` (distilled output).';
  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute in workspace root' },
      timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds' },
    },
    required: ['command'],
  };

  constructor(
    private readonly ms: MsAxiomAdapter,
    private readonly msBin: string,
    private readonly mode: BenchmarkMode,
    private readonly sandboxPlan: SandboxPlan,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return 'Error: command is required';
    const signal = context?.signal instanceof AbortSignal ? context.signal : undefined;

    if (this.mode === 'native') {
      const timeoutMs = typeof args.timeoutMs === 'number' ? Math.floor(args.timeoutMs) : undefined;
      const { output } = await this.ms.exec(command, { timeoutMs, signal });
      return output || '(Command produced no output)';
    }

    const blocked = destructiveReason(command);
    if (blocked) {
      return `[SECURITY WARNING: Command blocked by safety policy - ${blocked}]\nCommand: ${command}`;
    }

    const cwd = context?.workspaceRoot ?? process.cwd();
    const timeoutMs =
      typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : CONTROLLED_TIMEOUT_MS;
    const inv = buildControlledExecInvocation(command, cwd, this.sandboxPlan);
    const { output } = await execViaMsDistill(this.msBin, cwd, [inv.file, ...inv.args], {
      timeoutMs,
      env: scrubEnv(process.env),
      signal,
    });
    return output || '(Command produced no output)';
  }
}

class MsRunTestsTool extends BaseTool {
  readonly name = 'run_tests';
  readonly description = 'Run pytest in the workspace via `ms exec` (distilled output + failure context).';
  readonly parameters = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Optional pytest node id or path; omit for whole suite' },
    },
  };

  constructor(
    private readonly ms: MsAxiomAdapter,
    private readonly msBin: string,
    private readonly mode: BenchmarkMode,
    private readonly sandboxPlan: SandboxPlan,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const rawTarget = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : undefined;
    const signal = context?.signal instanceof AbortSignal ? context.signal : undefined;

    if (this.mode === 'native') {
      const cmd = rawTarget ? ['python3', '-m', 'pytest', rawTarget] : ['python3', '-m', 'pytest'];
      const { output } = await this.ms.exec(cmd, { signal });
      return output || '(pytest produced no output)';
    }

    const cwd = context?.workspaceRoot ?? process.cwd();
    let inv: { file: string; args: string[] };
    try {
      inv = buildControlledPytestInvocation(cwd, rawTarget, this.sandboxPlan);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const { output } = await execViaMsDistill(this.msBin, cwd, [inv.file, ...inv.args], {
      timeoutMs: CONTROLLED_TIMEOUT_MS,
      env: scrubEnv(process.env),
      signal,
    });
    return output || '(pytest produced no output)';
  }
}

class MsOutlineTool extends BaseTool {
  readonly name = 'ms_outline';
  readonly isReadOnly = true;
  readonly description = 'Get structural outline (classes, functions, line numbers) of workspace files.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional file or directory to outline' },
    },
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const rawPath = typeof args.path === 'string' ? toWorkspaceRel(args.path, context) : '';
    const targetPath = rawPath && rawPath !== '.' ? rawPath : undefined;
    const { records, completed } = await this.ms.outline(this.sessionId, { path: targetPath });
    if (completed.status !== 'ok') return formatMsError(completed);
    const items = records as Array<{
      path: string;
      lines: number;
      symbols: Array<{ kind: string; line: number; signature: string }>;
    }>;
    return items
      .map((f) => {
        const syms = f.symbols.map((s) => `  L${s.line}: ${s.signature}`).join('\n');
        return `${f.path} (${f.lines}L)${syms ? '\n' + syms : ''}`;
      })
      .join('\n');
  }
}

class MsContextTool extends BaseTool {
  readonly name = 'ms_context';
  readonly isReadOnly = true;
  readonly description =
    'Get focused context bundle (hashline snippet, imports, local symbols, related tests) around a file/line.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      line: { type: 'number', description: '1-based target line number' },
      symbol: { type: 'string', description: 'Optional symbol name' },
      radius: { type: 'number', description: 'Line radius around target' },
    },
    required: ['path'],
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const filePath = toWorkspaceRel(typeof args.path === 'string' ? args.path : '', context);
    if (!filePath) return 'Error: path is required';
    const { completed } = await this.ms.contextBundle(this.sessionId, filePath, {
      line: typeof args.line === 'number' ? Math.floor(args.line) : undefined,
      symbol: typeof args.symbol === 'string' ? args.symbol : undefined,
      radius: typeof args.radius === 'number' ? Math.floor(args.radius) : undefined,
    });
    if (completed.status !== 'ok' || !completed.result) return formatMsError(completed);
    const res = completed.result as {
      hashlineSnippet?: string;
      relatedTests?: string[];
      imports?: string[];
    };
    const parts = [res.hashlineSnippet ?? ''];
    if (res.relatedTests?.length) parts.push(`Related tests: ${res.relatedTests.join(', ')}`);
    return parts.filter(Boolean).join('\n');
  }
}

class MsUndoTool extends BaseTool {
  readonly name = 'ms_undo';
  readonly description = 'Undo the last `ms` file mutation transaction (conflict-aware).';
  readonly parameters = {
    type: 'object',
    properties: {
      transactionId: { type: 'string', description: 'Optional specific transaction id to undo' },
    },
  };

  constructor(private readonly ms: MsAxiomAdapter, private readonly sessionId: string) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const txId = typeof args.transactionId === 'string' && args.transactionId.trim() ? args.transactionId.trim() : undefined;
    const opId = `op-${crypto.randomUUID()}`;
    const { completed } = await this.ms.undo(this.sessionId, opId, txId);
    if (completed.status !== 'ok') return formatMsError(completed);
    return `Undid transaction ${txId ?? 'latest'}`;
  }
}

export function registerMsTools(
  registry: ToolRegistry,
  msAdapter: MsAxiomAdapter,
  msSessionId: string,
  msBin: string,
  mode: BenchmarkMode,
  sandboxPlan: SandboxPlan = planSandbox(),
): void {
  registry.unregisterTool('apply_patch');
  registry.registerTool(new MsReadTool(msAdapter, msSessionId));
  registry.registerTool(new MsListTool(msAdapter, msSessionId));
  registry.registerTool(new MsSearchTool(msAdapter, msSessionId));
  registry.registerTool(new MsEditTool(msAdapter, msSessionId));
  registry.registerTool(new MsWriteTool(msAdapter, msSessionId));
  registry.registerTool(new MsExecTool(msAdapter, msBin, mode, sandboxPlan));
  registry.registerTool(new MsRunTestsTool(msAdapter, msBin, mode, sandboxPlan));
  registry.registerTool(new MsOutlineTool(msAdapter, msSessionId));
  registry.registerTool(new MsContextTool(msAdapter, msSessionId));
  registry.registerTool(new MsUndoTool(msAdapter, msSessionId));
}

export function getArmToolDefinitionsHash(
  arm: 'A_baseline' | 'B_ms',
  mode: BenchmarkMode,
  msBin: string,
  sandboxPlan: SandboxPlan = planSandbox(),
): string {
  const registry = new ToolRegistry();
  if (arm === 'B_ms') {
    registerMsTools(registry, {} as MsAxiomAdapter, 'schema-hash', msBin, mode, sandboxPlan);
  }
  const defs = registry
    .getDefinitions()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return crypto.createHash('sha256').update(JSON.stringify(defs)).digest('hex');
}

export function buildToolTraceEntry(
  toolCallId: string,
  name: string,
  startedAtMonoMs: number,
  durationMs: number,
  output: string,
  isError: boolean,
  error?: string,
): ToolTraceEntry {
  const redactedOutput = redact(output);
  const { exitCode, timedOut } = extractExitMetadata(name, redactedOutput, isError);
  return {
    toolCallId,
    name,
    startedAtMonoMs: Number(startedAtMonoMs.toFixed(3)),
    durationMs: Number(durationMs.toFixed(3)),
    isError,
    toolOutputBytes: Buffer.byteLength(redactedOutput, 'utf8'),
    exitCode,
    timedOut,
    ...(isError ? { errorPreview: redact(String(error ?? redactedOutput)).slice(0, 300) } : {}),
  };
}
