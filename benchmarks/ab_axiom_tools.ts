import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { pythonBin } from '../../nhom-30/src/core/paths.js';
import { redact, scrubEnv, SECRET_NAME } from '../../nhom-30/src/core/secrets.js';
import { PYTEST_ARGS, TEST_TIMEOUT_MS } from '../../nhom-30/src/core/verifier.js';
import { BaseTool, type ToolExecutionContext } from '../../nhom-30/src/tools/base-tool.js';
import { BUNDLED_SKILLS_DIR, isBundledSkillFile } from '../../nhom-30/src/tools/bundled-skills.js';
import { destructiveReason } from '../../nhom-30/src/tools/bash.js';
import { escapesWorkspace } from '../../nhom-30/src/tools/permissions.js';
import { ReadTool } from '../../nhom-30/src/tools/read.js';
import { ToolRegistry } from '../../nhom-30/src/tools/registry.js';
import {
  bwrapInvocation,
  extraWritableFromEnv,
  planSandbox,
  type SandboxPlan,
} from '../../nhom-30/src/tools/sandbox.js';
import {
  attachFailureSnippetsViaRpc,
  distillCommandOutput,
  isReadOnlyInspectionCommand,
  MsAxiomAdapter,
  runProcessDirect,
  type EditSpec,
} from '../examples/axiom_adapter.js';

export type BenchmarkMode = 'controlled' | 'native';
export type BundledSkillMode = 'on' | 'off';

export const BUNDLED_SKILL_ALLOWLIST = new Set<string>([
  'skills/bug-fix/SKILL.md',
  'skills/issue-triage/SKILL.md',
]);

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
  turnIndex: number;
  name: string;
  startedAtMonoMs: number;
  durationMs: number;
  isError: boolean;
  argsPreview: string;
  argsTruncated: boolean;
  argsOriginalBytes: number;
  argsSha256: string;
  outputPreview: string;
  outputTruncated: boolean;
  outputOriginalBytes: number;
  outputSha256: string;
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

export function resolveAllowlistedBundledSkill(
  rawPath: string,
  workspaceRoot?: string,
): { relPath: string; bundledPath: string } | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  let relPosix: string;
  if (path.isAbsolute(trimmed)) {
    if (!workspaceRoot) return null;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(workspaceRoot);
    } catch {
      realRoot = path.resolve(workspaceRoot);
    }
    const rel = path.relative(realRoot, path.resolve(trimmed));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return null;
    }
    relPosix = rel.split(path.sep).join('/');
  } else {
    relPosix = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  }

  if (!BUNDLED_SKILL_ALLOWLIST.has(relPosix)) return null;
  const subPath = relPosix.slice('skills/'.length);
  const bundledPath = path.join(BUNDLED_SKILLS_DIR, subPath);
  if (!isBundledSkillFile(bundledPath)) return null;
  return { relPath: relPosix, bundledPath };
}

function hasWorkspaceSymlinkOrPermissionError(workspaceRoot: string | undefined, relPosix: string): boolean {
  if (!workspaceRoot) return false;
  const parts = relPosix.split('/').filter(Boolean);
  let current = workspaceRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return true;
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
      if (code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function formatBundledSkillHashline(
  bundledPath: string,
  startLine: number,
  lineCount: number,
): string {
  const raw = fs.readFileSync(bundledPath, 'utf8');
  const eol = raw.includes('\r\n') ? 'CRLF' : raw.includes('\n') ? 'LF' : 'NONE';
  const fileRev = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  const allLines = raw.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  const totalLines = allLines.length;
  if (totalLines === 0) {
    return `rev:${fileRev} eol:${eol} lines:0-0/0`;
  }
  const start = Math.max(1, Math.min(startLine, totalLines));
  const end = Math.max(start, Math.min(start + lineCount - 1, totalLines));
  const out = [`rev:${fileRev} eol:${eol} lines:${start}-${end}/${totalLines}`];
  for (let ln = start; ln <= end; ln++) {
    const text = allLines[ln - 1] ?? '';
    const tag = crypto.createHash('sha256').update(`${ln}:${text}`, 'utf8').digest('hex').slice(0, 4);
    out.push(`${ln}:${tag}| ${text}`);
  }
  return out.join('\n');
}

export class BaselineReadTool extends BaseTool {
  private readonly inner = new ReadTool();
  readonly name = this.inner.name;
  readonly isReadOnly = this.inner.isReadOnly;
  readonly description = this.inner.description;
  readonly parameters = this.inner.parameters;

  constructor(private readonly bundledSkillMode: BundledSkillMode = 'on') {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    try {
      return await this.inner.execute(args, context);
    } catch (err) {
      if (this.bundledSkillMode !== 'on') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('File or directory not found:')) throw err;

      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      const resolved = resolveAllowlistedBundledSkill(rawPath, context?.workspaceRoot);
      if (!resolved) throw err;
      if (hasWorkspaceSymlinkOrPermissionError(context?.workspaceRoot, resolved.relPath)) {
        throw err;
      }
      return await this.inner.execute({ ...args, path: resolved.bundledPath }, context);
    }
  }
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

  constructor(
    private readonly ms: MsAxiomAdapter,
    private readonly sessionId: string,
    private readonly bundledSkillMode: BundledSkillMode = 'on',
  ) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    const filePath = toWorkspaceRel(rawPath, context);
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
    if (completed.status === 'ok' && completed.result) {
      const res = completed.result as { hashline?: string };
      return res.hashline ?? '';
    }
    if (
      this.bundledSkillMode === 'on' &&
      completed.error?.code === 'E_NOT_FOUND'
    ) {
      const resolved = resolveAllowlistedBundledSkill(rawPath, context?.workspaceRoot);
      if (resolved && !hasWorkspaceSymlinkOrPermissionError(context?.workspaceRoot, resolved.relPath)) {
        return formatBundledSkillHashline(resolved.bundledPath, startLine, lineCount);
      }
    }
    return formatMsError(completed);
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
  readonly description = 'Execute a shell command in the workspace (fast distilled output).';
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
    private readonly sessionId: string,
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
      const { output } = await this.ms.exec(command, { timeoutMs, signal, sessionId: this.sessionId });
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
    const res = await runProcessDirect(inv.file, inv.args, {
      cwd,
      timeoutMs,
      env: scrubEnv(process.env),
      signal,
    });
    const kind = !isReadOnlyInspectionCommand(command) && /\bpytest\b/i.test(command) ? 'pytest' : 'generic';
    const firstPass = distillCommandOutput(res.rawOutput, {
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      kind,
      command,
    });
    if (firstPass.hasFailures) {
      const snippets = await attachFailureSnippetsViaRpc(this.ms, this.sessionId, cwd, firstPass.cleanedLines);
      if (snippets.length > 0) {
        return distillCommandOutput(res.rawOutput, {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          durationMs: res.durationMs,
          kind,
          command,
          snippets,
        }).output;
      }
    }
    return firstPass.output || '(Command produced no output)';
  }
}

class MsRunTestsTool extends BaseTool {
  readonly name = 'run_tests';
  readonly description = 'Run pytest in the workspace (fast distilled output + failure context).';
  readonly parameters = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Optional pytest node id or path; omit for whole suite' },
    },
  };

  constructor(
    private readonly ms: MsAxiomAdapter,
    private readonly sessionId: string,
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
      const { output } = await this.ms.exec(cmd, { signal, sessionId: this.sessionId, kind: 'pytest' });
      return output || '(pytest produced no output)';
    }

    const cwd = context?.workspaceRoot ?? process.cwd();
    let inv: { file: string; args: string[] };
    try {
      inv = buildControlledPytestInvocation(cwd, rawTarget, this.sandboxPlan);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const res = await runProcessDirect(inv.file, inv.args, {
      cwd,
      timeoutMs: CONTROLLED_TIMEOUT_MS,
      env: scrubEnv(process.env),
      signal,
    });
    const firstPass = distillCommandOutput(res.rawOutput, {
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      kind: 'pytest',
    });
    if (firstPass.hasFailures) {
      const snippets = await attachFailureSnippetsViaRpc(this.ms, this.sessionId, cwd, firstPass.cleanedLines);
      if (snippets.length > 0) {
        return distillCommandOutput(res.rawOutput, {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          durationMs: res.durationMs,
          kind: 'pytest',
          snippets,
        }).output;
      }
    }
    return firstPass.output || '(pytest produced no output)';
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

export function registerBaselineTools(
  registry: ToolRegistry,
  bundledSkillMode: BundledSkillMode = 'on',
): void {
  registry.registerTool(new BaselineReadTool(bundledSkillMode));
}

export function registerMsTools(
  registry: ToolRegistry,
  msAdapter: MsAxiomAdapter,
  msSessionId: string,
  _msBin: string,
  mode: BenchmarkMode,
  sandboxPlan: SandboxPlan = planSandbox(),
  options?: { includeExtraTools?: boolean; bundledSkillMode?: BundledSkillMode },
): void {
  registry.unregisterTool('apply_patch');
  registry.registerTool(new MsReadTool(msAdapter, msSessionId, options?.bundledSkillMode ?? 'on'));
  registry.registerTool(new MsListTool(msAdapter, msSessionId));
  registry.registerTool(new MsSearchTool(msAdapter, msSessionId));
  registry.registerTool(new MsEditTool(msAdapter, msSessionId));
  registry.registerTool(new MsWriteTool(msAdapter, msSessionId));
  registry.registerTool(new MsExecTool(msAdapter, msSessionId, mode, sandboxPlan));
  registry.registerTool(new MsRunTestsTool(msAdapter, msSessionId, mode, sandboxPlan));
  if (options?.includeExtraTools) {
    registry.registerTool(new MsOutlineTool(msAdapter, msSessionId));
    registry.registerTool(new MsContextTool(msAdapter, msSessionId));
    registry.registerTool(new MsUndoTool(msAdapter, msSessionId));
  }
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
  } else {
    registerBaselineTools(registry, 'on');
  }
  const defs = registry
    .getDefinitions()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return crypto.createHash('sha256').update(JSON.stringify(defs)).digest('hex');
}

function redactUnknownValue(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactUnknownValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_NAME.test(k)) {
      out[k] = '‹redacted›';
    } else {
      out[k] = redactUnknownValue(v);
    }
  }
  return out;
}

function truncateUtf8Bytes(text: string, maxBytes: number): { preview: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { preview: text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { preview: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function buildPreviewTelemetry(
  redactedText: string,
  maxBytes: number,
): { preview: string; truncated: boolean; originalBytes: number; sha256: string } {
  const originalBytes = Buffer.byteLength(redactedText, 'utf8');
  const sha256 = crypto.createHash('sha256').update(redactedText, 'utf8').digest('hex');
  const { preview, truncated } = truncateUtf8Bytes(redactedText, maxBytes);
  return { preview, truncated, originalBytes, sha256 };
}

export const DEFAULT_ARGS_PREVIEW_BYTES = 512;
export const DEFAULT_OUTPUT_PREVIEW_BYTES = 1024;

export function buildToolTraceEntry(
  toolCallId: string,
  name: string,
  startedAtMonoMs: number,
  durationMs: number,
  output: string,
  isError: boolean,
  error?: string,
  options?: {
    turnIndex?: number;
    args?: unknown;
    maxArgsPreviewBytes?: number;
    maxOutputPreviewBytes?: number;
  },
): ToolTraceEntry {
  const rawArgs =
    options?.args === undefined
      ? '{}'
      : typeof options.args === 'string'
        ? redact(options.args)
        : redact(JSON.stringify(redactUnknownValue(options.args)) ?? '{}');
  const argsTel = buildPreviewTelemetry(rawArgs, options?.maxArgsPreviewBytes ?? DEFAULT_ARGS_PREVIEW_BYTES);

  const redactedOutput = redact(output);
  const outputTel = buildPreviewTelemetry(redactedOutput, options?.maxOutputPreviewBytes ?? DEFAULT_OUTPUT_PREVIEW_BYTES);

  const { exitCode, timedOut } = extractExitMetadata(name, redactedOutput, isError);
  const redactedError = isError ? redact(String(error ?? redactedOutput)) : undefined;
  const errorPreview =
    redactedError !== undefined ? truncateUtf8Bytes(redactedError, 300).preview : undefined;

  return {
    toolCallId,
    turnIndex: options?.turnIndex ?? 0,
    name,
    startedAtMonoMs: Number(startedAtMonoMs.toFixed(3)),
    durationMs: Number(durationMs.toFixed(3)),
    isError,
    argsPreview: argsTel.preview,
    argsTruncated: argsTel.truncated,
    argsOriginalBytes: argsTel.originalBytes,
    argsSha256: argsTel.sha256,
    outputPreview: outputTel.preview,
    outputTruncated: outputTel.truncated,
    outputOriginalBytes: outputTel.originalBytes,
    outputSha256: outputTel.sha256,
    toolOutputBytes: outputTel.originalBytes,
    exitCode,
    timedOut,
    ...(errorPreview !== undefined ? { errorPreview } : {}),
  };
}
