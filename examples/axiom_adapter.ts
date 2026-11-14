/**
 * Typed Axiom -> `ms` NDJSON stdio + `ms exec` adapter.
 *
 * Design rules enforced by this adapter:
 * 1. Inspect `initialize.capabilities` at runtime; never infer capabilities from `serverVersion`.
 * 2. Typed operations (`read`, `search`, `edit`, `write_file`, `delete_file`, `rename_file`,
 *    `outline`, `context_bundle`, `tx.undo`) + distilled `exec`/`log` helpers.
 * 3. Session capabilities can only narrow the Axiom role's policy (e.g. reviewer -> `allowWrite: false`).
 * 4. Propagate `AbortSignal` -> `cancel` and `deadlineMs` to `ms`, and preserve `operationId`
 *    so interrupted mutations can be reconciled via `tx.list` or idempotent retry.
 * 5. Enforce Axiom's `test-guard` (`findChangeTampering`) hook on every file mutation path.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export type ErrorCode =
  | "E_PROTOCOL"
  | "E_DUPLICATE_REQUEST_ID"
  | "E_INVALID_REQUEST"
  | "E_UNKNOWN_COMMAND"
  | "E_UNSUPPORTED"
  | "E_SESSION_NOT_FOUND"
  | "E_POLICY_DENIED"
  | "E_NOT_FOUND"
  | "E_CONFLICT"
  | "E_UNDO_CONFLICT"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_IDEMPOTENCY_EXPIRED"
  | "E_WORKSPACE_LOCKED"
  | "E_RECOVERY_CONFLICT"
  | "E_RESOURCE_LIMIT"
  | "E_CANCELLED"
  | "E_TIMEOUT"
  | "E_IO"
  | "E_INTERNAL";

export interface CompletedEvent<T = unknown> {
  requestId: string;
  seq: number;
  type: "completed";
  status: "ok" | "error" | "cancelled" | "timeout" | "limit_exceeded";
  truncated: boolean;
  counters: {
    recordsEmitted: number;
    bytesEmitted: number;
    durationMs: number;
  };
  result?: T;
  error?: {
    code: ErrorCode;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

export interface RecordsEvent<R = unknown> {
  requestId: string;
  seq: number;
  type: "records";
  records: R[];
  schemaVersion?: string;
}

export interface Capabilities {
  operations: string[];
  allowWrite: boolean;
  allowExternalExec: boolean;
  supportsCancellation: boolean;
  supportsIdempotency: boolean;
  maxLimits: {
    maxFrameBytes: number;
    maxEditFileBytes: number;
    maxBatchRecords: number;
    maxOutputBytesPerRequest: number;
    defaultDeadlineMs: number;
    maxDeadlineMs: number;
    maxConcurrentReadsPerConnection: number;
    maxConcurrentMutationsPerWorkspace: number;
  };
}

export interface TextEdit {
  startByte: number;
  endByte: number;
  expectedText?: string;
  expectedTag?: string;
  replacement: string;
}

export type EditSpec =
  | {
      startLine: number;
      endLine: number;
      startTag?: string;
      endTag?: string;
      replacement: string;
    }
  | {
      oldText: string;
      newText: string;
    }
  | TextEdit;

export interface TestGuardOptions {
  allowedTests?: readonly string[];
}

export interface AxiomRolePolicy {
  allowWrite: boolean;
  readSubpaths?: string[];
  writeSubpaths?: string[];
  defaultDeadlineMs?: number;
  testGuard?: TestGuardOptions | false;
}

// ---------------------------------------------------------------------------
// Axiom `test-guard` (`findChangeTampering`)
// ---------------------------------------------------------------------------

const CHECK_LINE =
  /\bassert\b|self\.assert\w*\s*\(|pytest\.(?:raises|warns|approx)\b|^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*|^\s*(?:#\[test\]|it\s*\(|test\s*\(|expect\s*\()/;
const SKIP_LINE =
  /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bunittest\.SkipTest\b|\braise\s+SkipTest\b|#\[ignore\]|\b(?:it|test)\.skip\s*\(/;
const DESELECT_LINE =
  /\baddopts\b|--deselect\b|--ignore(?:-glob)?\b|(?:^|\s)-k\s|\bcollect_ignore(?:_glob)?\b|\bpytest_(?:collection_modifyitems|ignore_collect|collect_file|deselected)\b|\b(?:testpaths|norecursedirs|python_files|python_classes|python_functions)\b/;

function normalizeRel(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function relativeTo(root: string, p: string): string {
  const n = normalizeRel(p);
  return path.isAbsolute(p) ? normalizeRel(path.relative(root, p)) : n;
}

export function isTestPath(p: string): boolean {
  const n = normalizeRel(p);
  const base = n.split("/").pop() ?? "";
  return (
    /(^|\/)tests\//.test(n) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(?:py|rs|go)$/.test(base) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    base === "conftest.py"
  );
}

function isTestConfigPath(p: string): boolean {
  const base = normalizeRel(p).split("/").pop() ?? "";
  return /^(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/.test(base);
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function checkTestLines(
  rel: string,
  removed: readonly string[],
  added: readonly string[],
  deleted: boolean,
): string | null {
  const isTest = isTestPath(rel);
  const isConfig = isTestConfigPath(rel);
  if (!isTest && !isConfig) return null;

  const refuse = (what: string) =>
    `refusing to change ${rel}: ${what}. Existing tests must not be weakened; fix the code under test instead.`;

  if (isTest && deleted) return refuse("it deletes or moves an existing test file");

  const squash = (line: string) => line.replace(/\s+/g, "");
  const quote = (line: string) => JSON.stringify(line.trim().slice(0, 120));

  if (isTest) {
    const kept = new Map<string, number>();
    for (const line of added) kept.set(squash(line), (kept.get(squash(line)) ?? 0) + 1);
    for (const line of removed) {
      if (!CHECK_LINE.test(line)) continue;
      const count = kept.get(squash(line)) ?? 0;
      if (count === 0) return refuse(`it removes or changes the check ${quote(line)}`);
      kept.set(squash(line), count - 1);
    }
  }
  const skip = added.find((line) => SKIP_LINE.test(line));
  if (skip) return refuse(`it adds ${quote(skip)}, which skips or excuses a test`);

  const deselect =
    (rel.endsWith("conftest.py") || isConfig) && added.find((line) => DESELECT_LINE.test(line));
  if (deselect) return refuse(`it adds ${quote(deselect)}, which changes which tests are collected`);

  return null;
}

/**
 * Axiom `test-guard` hook: returns `null` if allowed, or refusal reason if a mutation
 * weakens, skips, or deletes existing tests.
 */
export function findChangeTampering(
  filePath: string,
  before: string | null,
  after: string | null,
  workspaceRoot: string,
  opts?: TestGuardOptions,
): string | null {
  const rel = relativeTo(workspaceRoot, filePath);
  if ((opts?.allowedTests ?? []).some((allowed) => normalizeRel(allowed) === rel)) {
    return null;
  }
  const oldLines = before === null ? [] : splitLines(before);
  const newLines = after === null ? [] : splitLines(after);
  const remaining = new Map<string, number>();
  for (const line of newLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of oldLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else removed.push(line);
  }
  const added = [...remaining].flatMap(([line, count]) => Array<string>(count).fill(line));
  return checkTestLines(rel, removed, added, before !== null && after === null);
}

// ---------------------------------------------------------------------------
// Adapter Client
// ---------------------------------------------------------------------------

interface PendingRequest {
  records: unknown[];
  resolve: (value: { records: unknown[]; completed: CompletedEvent }) => void;
  reject: (err: Error) => void;
}

export class MsAxiomAdapter {
  private proc: ChildProcessWithoutNullStreams;
  private msBin: string;
  private workspaceRoot: string;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private capabilities: Capabilities | null = null;
  private testGuardOpts: TestGuardOptions | false = {};

  constructor(msBin: string, workspaceRoot: string, stateDir?: string, allowWrite = false) {
    this.msBin = msBin;
    this.workspaceRoot = workspaceRoot;

    const args = ["--root", workspaceRoot];
    if (allowWrite) {
      if (!stateDir) {
        throw new Error("stateDir is required when allowWrite is true");
      }
      args.push("--allow-write", "--state-dir", stateDir);
    }

    this.proc = spawn(msBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", (code) => {
      for (const [, req] of this.pending) {
        req.reject(new Error(`ms exited with code ${code ?? "null"}`));
      }
      this.pending.clear();
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.type === "protocol_error") {
      if (ev.fatal) {
        this.proc.kill();
      }
      return;
    }
    const reqId = ev.requestId as string | undefined;
    if (!reqId) return;
    const entry = this.pending.get(reqId);
    if (!entry) return;

    if (ev.type === "records") {
      entry.records.push(...(ev as RecordsEvent).records);
    } else if (ev.type === "completed") {
      this.pending.delete(reqId);
      entry.resolve({ records: entry.records, completed: ev as CompletedEvent });
    }
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ records: unknown[]; completed: CompletedEvent }> {
    const id = `ax-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { records: [], resolve, reject });

      const onAbort = () => {
        const cancelId = `ax-${this.nextId++}`;
        this.proc.stdin.write(
          JSON.stringify({ id: cancelId, method: "cancel", params: { requestId: id } }) + "\n",
        );
      };

      if (signal?.aborted) {
        this.pending.delete(id);
        reject(new Error("aborted before dispatch"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<Capabilities> {
    const { completed } = await this.sendRequest("initialize", {
      clientName: "axiom",
      clientVersion: "0.2.0",
    });
    if (completed.status !== "ok" || !completed.result) {
      throw new Error(`initialize failed: ${completed.error?.message ?? completed.status}`);
    }
    const res = completed.result as { capabilities: Capabilities };
    this.capabilities = res.capabilities;
    return res.capabilities;
  }

  async openSession(role: AxiomRolePolicy): Promise<string> {
    if (!this.capabilities) {
      await this.initialize();
    }
    this.testGuardOpts = role.testGuard === false ? false : (role.testGuard ?? {});
    const effectiveWrite = Boolean(this.capabilities?.allowWrite && role.allowWrite);
    const { completed } = await this.sendRequest("session.open", {
      capabilities: {
        allowWrite: effectiveWrite,
        readSubpaths: role.readSubpaths,
        writeSubpaths: effectiveWrite ? role.writeSubpaths : undefined,
        limits: role.defaultDeadlineMs ? { defaultDeadlineMs: role.defaultDeadlineMs } : undefined,
      },
    });
    if (completed.status !== "ok" || !completed.result) {
      throw new Error(`session.open failed: ${completed.error?.message ?? completed.status}`);
    }
    return (completed.result as { sessionId: string }).sessionId;
  }

  async readFile(
    sessionId: string,
    filePath: string,
    startLine = 1,
    lineCount = 200,
    opts?: { format?: "json" | "hashline"; deadlineMs?: number },
    signal?: AbortSignal,
  ) {
    return this.sendRequest(
      "call",
      {
        sessionId,
        deadlineMs: opts?.deadlineMs,
        operation: {
          kind: "read",
          path: filePath,
          startLine,
          lineCount,
          format: opts?.format ?? "hashline",
        },
      },
      signal,
    );
  }

  async search(
    sessionId: string,
    query: string,
    opts?: {
      path?: string;
      regex?: boolean;
      caseSensitive?: boolean;
      maxMatches?: number;
      contextLines?: number;
      deadlineMs?: number;
    },
    signal?: AbortSignal,
  ) {
    return this.sendRequest(
      "call",
      {
        sessionId,
        deadlineMs: opts?.deadlineMs,
        operation: {
          kind: "search",
          query,
          path: opts?.path,
          regex: opts?.regex,
          caseSensitive: opts?.caseSensitive,
          maxMatches: opts?.maxMatches,
          contextLines: opts?.contextLines,
        },
      },
      signal,
    );
  }

  async outline(
    sessionId: string,
    opts?: { path?: string; maxFiles?: number; maxSymbolsPerFile?: number; deadlineMs?: number },
    signal?: AbortSignal,
  ) {
    return this.sendRequest(
      "call",
      {
        sessionId,
        deadlineMs: opts?.deadlineMs,
        operation: {
          kind: "outline",
          path: opts?.path,
          maxFiles: opts?.maxFiles,
          maxSymbolsPerFile: opts?.maxSymbolsPerFile,
        },
      },
      signal,
    );
  }

  async contextBundle(
    sessionId: string,
    filePath: string,
    opts?: { line?: number; symbol?: string; radius?: number; deadlineMs?: number },
    signal?: AbortSignal,
  ) {
    return this.sendRequest(
      "call",
      {
        sessionId,
        deadlineMs: opts?.deadlineMs,
        operation: {
          kind: "context_bundle",
          path: filePath,
          line: opts?.line,
          symbol: opts?.symbol,
          radius: opts?.radius,
        },
      },
      signal,
    );
  }

  private async readFullTextForGuard(sessionId: string, filePath: string): Promise<string | null> {
    const { records, completed } = await this.sendRequest("call", {
      sessionId,
      operation: { kind: "read", path: filePath, startLine: 1, lineCount: 100_000, format: "json" },
    });
    if (completed.status !== "ok") return null;
    return (records as Array<{ text: string }>).map((r) => r.text).join("\n");
  }

  private enforceTestGuard(filePath: string, before: string | null, after: string | null): void {
    if (this.testGuardOpts === false) return;
    if (!isTestPath(filePath) && !isTestConfigPath(filePath)) return;
    const reason = findChangeTampering(filePath, before, after, this.workspaceRoot, this.testGuardOpts);
    if (reason) {
      throw new Error(`test-guard blocked mutation: ${reason}`);
    }
  }

  async patchFile(
    sessionId: string,
    operationId: string,
    filePath: string,
    expectedRevision: string,
    edits: TextEdit[],
    opts?: { dryRun?: boolean; deadlineMs?: number },
  ) {
    if (this.testGuardOpts !== false && (isTestPath(filePath) || isTestConfigPath(filePath))) {
      const before = await this.readFullTextForGuard(sessionId, filePath);
      if (before !== null) {
        const buf = Buffer.from(before, "utf8");
        const removed = edits
          .map((e) => e.expectedText ?? buf.subarray(e.startByte, e.endByte).toString("utf8"))
          .join("\n");
        const added = edits.map((e) => e.replacement).join("\n");
        this.enforceTestGuard(filePath, removed, added);
      }
    }
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "patch",
        path: filePath,
        expectedRevision,
        edits,
        dryRun: opts?.dryRun,
      },
    });
  }

  async editFile(
    sessionId: string,
    operationId: string,
    filePath: string,
    edits: EditSpec[],
    opts?: { expectedRevision?: string; dryRun?: boolean; deadlineMs?: number },
  ) {
    if (this.testGuardOpts !== false && (isTestPath(filePath) || isTestConfigPath(filePath))) {
      const needsRead = edits.some((e) => !("oldText" in e) && !("expectedText" in e && e.expectedText !== undefined));
      const before = needsRead ? await this.readFullTextForGuard(sessionId, filePath) : null;
      const beforeLines = before !== null ? splitLines(before) : [];
      const beforeBuf = before !== null ? Buffer.from(before, "utf8") : Buffer.alloc(0);

      const removed = edits
        .map((e) => {
          if ("oldText" in e) return e.oldText;
          if ("startLine" in e) {
            return beforeLines.slice(Math.max(0, e.startLine - 1), e.endLine).join("\n");
          }
          return e.expectedText ?? beforeBuf.subarray(e.startByte, e.endByte).toString("utf8");
        })
        .join("\n");
      const added = edits
        .map((e) => ("newText" in e ? e.newText : e.replacement))
        .join("\n");
      this.enforceTestGuard(filePath, removed, added);
    }
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "edit",
        path: filePath,
        expectedRevision: opts?.expectedRevision,
        edits,
        dryRun: opts?.dryRun,
      },
    });
  }

  async writeFile(
    sessionId: string,
    operationId: string,
    filePath: string,
    content: string,
    opts?: { createIfMissing?: boolean; overwrite?: boolean; expectedRevision?: string; dryRun?: boolean; deadlineMs?: number },
  ) {
    if (this.testGuardOpts !== false && (isTestPath(filePath) || isTestConfigPath(filePath))) {
      const before = await this.readFullTextForGuard(sessionId, filePath);
      this.enforceTestGuard(filePath, before, content);
    }
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "write_file",
        path: filePath,
        content,
        createIfMissing: opts?.createIfMissing,
        overwrite: opts?.overwrite,
        expectedRevision: opts?.expectedRevision,
        dryRun: opts?.dryRun,
      },
    });
  }

  async deleteFile(
    sessionId: string,
    operationId: string,
    filePath: string,
    opts?: { expectedRevision?: string; dryRun?: boolean; deadlineMs?: number },
  ) {
    if (this.testGuardOpts !== false && isTestPath(filePath)) {
      const before = await this.readFullTextForGuard(sessionId, filePath);
      this.enforceTestGuard(filePath, before ?? "", null);
    }
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "delete_file",
        path: filePath,
        expectedRevision: opts?.expectedRevision,
        dryRun: opts?.dryRun,
      },
    });
  }

  async renameFile(
    sessionId: string,
    operationId: string,
    from: string,
    to: string,
    opts?: { expectedRevision?: string; overwrite?: boolean; dryRun?: boolean; deadlineMs?: number },
  ) {
    if (this.testGuardOpts !== false && isTestPath(from) && !isTestPath(to)) {
      const before = await this.readFullTextForGuard(sessionId, from);
      this.enforceTestGuard(from, before ?? "", null);
    }
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "rename_file",
        from,
        to,
        expectedRevision: opts?.expectedRevision,
        overwrite: opts?.overwrite,
        dryRun: opts?.dryRun,
      },
    });
  }

  async undo(sessionId: string, operationId: string, transactionId?: string, deadlineMs?: number) {
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs,
      operation: {
        kind: "tx.undo",
        transactionId,
      },
    });
  }

  /** Executes a command in-process with `ms`-style distillation + hashline failure snippets (no cold `ms exec` spawn). */
  async exec(
    command: string | string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal; sessionId?: string; kind?: "pytest" | "generic" },
  ): Promise<{ exitCode: number; output: string }> {
    const cmdArgs = Array.isArray(command) ? command : [command];
    const isStringCmd = !Array.isArray(command);
    const file = isStringCmd ? "/bin/sh" : cmdArgs[0]!;
    const args = isStringCmd ? ["-c", command] : cmdArgs.slice(1);
    const res = await runProcessDirect(file, args, {
      cwd: this.workspaceRoot,
      timeoutMs: opts?.timeoutMs ?? 60_000,
      signal: opts?.signal,
    });
    const kind = opts?.kind ?? (cmdArgs.join(" ").toLowerCase().includes("pytest") ? "pytest" : "generic");
    const firstPass = distillCommandOutput(res.rawOutput, {
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      kind,
    });
    if ((res.exitCode !== 0 || res.timedOut) && opts?.sessionId) {
      const snippets = await attachFailureSnippetsViaRpc(
        this,
        opts.sessionId,
        this.workspaceRoot,
        firstPass.cleanedLines,
      );
      if (snippets.length > 0) {
        const finalPass = distillCommandOutput(res.rawOutput, {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          durationMs: res.durationMs,
          kind,
          snippets,
        });
        return { exitCode: res.exitCode, output: finalPass.output };
      }
    }
    return { exitCode: res.exitCode, output: firstPass.output };
  }

  /** Reads persisted raw command log via `ms log`. */
  async readLog(id: string, opts?: { tail?: number; grep?: string }): Promise<string> {
    const args = ["log", "--id", id];
    if (opts?.tail !== undefined) args.push("--tail", String(opts.tail));
    if (opts?.grep !== undefined) args.push("--grep", opts.grep);

    return new Promise((resolve, reject) => {
      const child = spawn(this.msBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(err || `ms log exited with ${code}`));
        else resolve(out.trimEnd());
      });
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sendRequest("session.close", { sessionId });
  }

  shutdown(): void {
    this.proc.stdin.end();
  }
}

// ---------------------------------------------------------------------------
// In-Process Command Execution & Distillation (zero cold-start `ms exec`)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const LOC_RE = /(?:-->\s*|at\s+[^\n]*?\(|File\s+")?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:[:\(]|",\s*line\s*)(\d+)/g;

export function cleanAndCollapseLines(raw: string): string[] {
  const stripped = raw.replace(ANSI_RE, "");
  const collapsed: Array<{ line: string; count: number }> = [];
  for (const rawLine of stripped.split("\n")) {
    let line: string;
    if (rawLine.includes("\r")) {
      const segs = rawLine.split("\r");
      let lastNonEmpty = "";
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i]!.length > 0) {
          lastNonEmpty = segs[i]!;
          break;
        }
      }
      line = lastNonEmpty.trimEnd();
    } else {
      line = rawLine.trimEnd();
    }
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.line === line) {
      prev.count += 1;
    } else {
      collapsed.push({ line, count: 1 });
    }
  }
  return collapsed.map(({ line, count }) => (count > 1 && line.length > 0 ? `${line} (x${count})` : line));
}

function truncateLines(lines: readonly string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more lines)`;
}

function distillPytestLines(passed: boolean, lines: readonly string[]): string {
  if (passed) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (l.includes(" passed") && (l.startsWith("=") || l.includes(" in "))) {
        return l.trim().replace(/^=+|=+$/g, "").trim();
      }
    }
    return "pytest passed";
  }
  const kept: string[] = [];
  let capture = false;
  for (const l of lines) {
    if (
      l.startsWith("==== FAILURES ====") ||
      l.startsWith("==== ERRORS ====") ||
      l.startsWith("==== short test summary info ====")
    ) {
      capture = true;
      kept.push(l);
    } else if (capture || l.startsWith("E   ") || l.startsWith("FAILED ") || l.includes("Error:")) {
      kept.push(l);
    }
  }
  if (kept.length === 0) return distillGenericLines(false, lines);
  return truncateLines(kept, 60);
}

function distillGenericLines(passed: boolean, lines: readonly string[]): string {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (passed) {
    return nonEmpty.slice(-5).join("\n");
  }
  const errs = nonEmpty.filter((l) => {
    const low = l.toLowerCase();
    return (
      low.includes("error") ||
      low.includes("fail") ||
      low.includes("panic") ||
      low.includes("exception") ||
      low.includes("traceback")
    );
  });
  if (errs.length > 0) return truncateLines(errs, 40);
  return nonEmpty.slice(-25).join("\n");
}

export function distillCommandOutput(
  raw: string,
  opts: {
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
    kind?: "pytest" | "generic";
    snippets?: readonly string[];
  },
): { cleanedLines: string[]; output: string } {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const rawLines = raw.length === 0 ? 0 : raw.split("\n").length;
  const cleanedLines = cleanAndCollapseLines(raw);
  const passed = opts.exitCode === 0 && !opts.timedOut;

  let body: string;
  if (passed && cleanedLines.length <= 15 && rawBytes <= 800) {
    body = cleanedLines.filter((l) => l.trim().length > 0).join("\n");
  } else if (opts.kind === "pytest") {
    body = distillPytestLines(passed, cleanedLines);
  } else {
    body = distillGenericLines(passed, cleanedLines);
  }

  let out = opts.timedOut
    ? `[TIMED OUT after ${opts.durationMs}ms | exit:${opts.exitCode} | raw:${rawLines}L/${rawBytes}B]`
    : opts.exitCode === 0
      ? `[OK | exit:0 | ${opts.durationMs}ms | raw:${rawLines}L/${rawBytes}B]`
      : `[FAILED | exit:${opts.exitCode} | ${opts.durationMs}ms | raw:${rawLines}L/${rawBytes}B]`;

  if (body.length > 0) {
    out += `\n${body}`;
  }
  if (!passed && opts.snippets && opts.snippets.length > 0) {
    out += `\n--- context snippets ---\n${opts.snippets.join("\n")}`;
  }
  return { cleanedLines, output: out };
}

export async function runProcessDirect(
  file: string,
  args: readonly string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<{ exitCode: number; timedOut: boolean; durationMs: number; rawOutput: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const killTree = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    };

    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, opts.timeoutMs)
        : undefined;

    const onAbort = () => killTree();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      let combined = stdout;
      if (stderr.length > 0) {
        if (combined.length > 0 && !combined.endsWith("\n")) combined += "\n";
        combined += stderr;
      }
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        durationMs: Date.now() - started,
        rawOutput: combined,
      });
    });
  });
}

export async function attachFailureSnippetsViaRpc(
  ms: MsAxiomAdapter,
  sessionId: string,
  workspaceRoot: string,
  cleanedLines: readonly string[],
  maxSnippets = 3,
): Promise<string[]> {
  const seen = new Set<string>();
  const snippets: string[] = [];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    realRoot = path.resolve(workspaceRoot);
  }

  for (const line of cleanedLines) {
    LOC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LOC_RE.exec(line)) !== null) {
      const rawPath = match[1]!.trim().replace(/^\.\//, "");
      const lineNum = Number(match[2]);
      if (!rawPath || !Number.isInteger(lineNum) || lineNum <= 0) continue;

      let relPath = rawPath;
      if (path.isAbsolute(rawPath)) {
        const rel = path.relative(realRoot, rawPath).split(path.sep).join("/");
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
        relPath = rel;
      }
      const key = `${relPath}:${lineNum}`;
      if (seen.has(key)) continue;

      try {
        const startLine = Math.max(1, lineNum - 2);
        const { completed } = await ms.readFile(sessionId, relPath, startLine, 5, { format: "hashline" });
        if (completed.status === "ok" && completed.result) {
          const res = completed.result as { hashline?: string };
          if (res.hashline) {
            snippets.push(`@ ${relPath}:${lineNum}\n${res.hashline}`);
            seen.add(key);
            if (snippets.length >= maxSnippets) return snippets;
          }
        }
      } catch {
        // ignore unreadable/missing snippet targets
      }
    }
  }
  return snippets;
}
