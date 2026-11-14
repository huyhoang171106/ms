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

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
    if (this.testGuardOpts !== false && isTestPath(filePath)) {
      const before = await this.readFullTextForGuard(sessionId, filePath);
      if (before !== null) {
        const afterGuess = edits.map((e) => e.replacement).join("\n");
        const removedText = edits.map((e) => e.expectedText ?? "").join("\n");
        if (removedText) {
          this.enforceTestGuard(filePath, removedText, afterGuess);
        }
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
      const removed = edits
        .map((e) => ("oldText" in e ? e.oldText : "expectedText" in e ? (e.expectedText ?? "") : ""))
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

  /** Executes a distilled command via `ms exec` with timeout and AbortSignal support. */
  async exec(
    command: string | string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; output: string }> {
    const cmdArgs = Array.isArray(command) ? command : [command];
    const args = ["exec", "--root", this.workspaceRoot];
    if (opts?.timeoutMs) {
      args.push("--timeout", String(opts.timeoutMs));
    }
    args.push("--", ...cmdArgs);

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
      const onAbort = () => child.kill("SIGTERM");
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? 1, output: (out || err).trimEnd() });
      });
    });
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
