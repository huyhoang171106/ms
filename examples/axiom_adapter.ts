/**
 * Typed Axiom -> `ms` NDJSON stdio adapter example (Section 6).
 *
 * Design rules enforced by this adapter:
 * 1. Inspect `initialize.capabilities` at runtime; never infer capabilities from `serverVersion`.
 * 2. Never expose a generic `ms.exec` tool; each operation maps to a typed capability.
 * 3. Session capabilities can only narrow the Axiom role's policy (e.g. reviewer -> `allowWrite: false`).
 * 4. Propagate `AbortSignal` -> `cancel` and `deadlineMs` to `ms`, and preserve `transactionId` / `operationId`
 *    so interrupted mutations can be reconciled via `tx.list` or idempotent retry.
 */

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

export interface AxiomRolePolicy {
  allowWrite: boolean;
  readSubpaths?: string[];
  writeSubpaths?: string[];
  defaultDeadlineMs?: number;
}

interface PendingRequest {
  records: unknown[];
  resolve: (value: { records: unknown[]; completed: CompletedEvent }) => void;
  reject: (err: Error) => void;
}

export class MsAxiomAdapter {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private capabilities: Capabilities | null = null;

  constructor(msBin: string, workspaceRoot: string, stateDir?: string, allowWrite = false) {
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
        // Fire-and-forget cancel using a distinct request ID.
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
      clientVersion: "0.1.0",
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
    // Never widen host capabilities; only narrow to match the Axiom role.
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
    path: string,
    startLine = 1,
    lineCount = 200,
    deadlineMs?: number,
    signal?: AbortSignal,
  ) {
    return this.sendRequest(
      "call",
      {
        sessionId,
        deadlineMs,
        operation: { kind: "read", path, startLine, lineCount },
      },
      signal,
    );
  }

  async search(
    sessionId: string,
    query: string,
    opts?: { path?: string; regex?: boolean; maxMatches?: number; deadlineMs?: number },
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
          maxMatches: opts?.maxMatches,
        },
      },
      signal,
    );
  }

  async patchFile(
    sessionId: string,
    operationId: string,
    path: string,
    expectedRevision: string,
    edits: TextEdit[],
    opts?: { dryRun?: boolean; deadlineMs?: number },
  ) {
    return this.sendRequest("call", {
      sessionId,
      operationId,
      deadlineMs: opts?.deadlineMs,
      operation: {
        kind: "patch",
        path,
        expectedRevision,
        edits,
        dryRun: opts?.dryRun,
      },
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sendRequest("session.close", { sessionId });
  }

  shutdown(): void {
    this.proc.stdin.end();
  }
}
