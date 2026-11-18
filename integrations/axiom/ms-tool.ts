/**
 * `ms` — the single Axiom tool.
 *
 * Axiom used to offer read_file, write_file, edit, apply_patch, list_dir, search_code, run_command and
 * run_tests. Each one is a round trip and a schema. This is one tool: the model writes a JavaScript
 * program, `ms` runs it against the workspace, and only the returned value comes back.
 *
 * Everything the old tools guaranteed still holds, because the program runs on the `ms` runtime:
 * root-confined openat2 resolution, BLAKE3 revisions, atomic journaled writes, batch rollback,
 * durable undo, the Axiom test-guard, and distilled command output.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Capabilities,
  type CompletedEvent,
  type EditSpec,
  MsAxiomAdapter,
  isReadOnlyInspectionCommand,
  isTestPath,
  isTestConfigPath,
} from "../../examples/axiom_adapter.js";
import { JobRegistry } from "./jobs.js";
import { cap, DEFAULT_LIMITS, type HostFn, type KernelLimits, runProgram } from "./kernel.js";
import { createSnapshot, sandboxCommand } from "./snapshot.js";

export interface MutationRequest {
  kind: "write" | "edit" | "batch" | "delete" | "rename" | "undo" | "exec";
  reason: string;
  path?: string;
  paths?: string[];
  command?: string;
}

/** `allow` runs it; any other answer (string or `deny`) refuses with that reason. */
export type Approve = (request: MutationRequest) => Promise<"allow" | "deny" | string>;

export interface MsToolOptions {
  msBin: string;
  workspaceRoot: string;
  /** Required when writes are enabled: ms keeps its journal outside the writable root. */
  stateDir?: string;
  allowWrite?: boolean;
  /** Fail closed: without this hook (or the explicit opt-out) every mutation is refused. */
  approve?: Approve;
  allowUnapprovedWrites?: boolean;
  /** Role narrowing: refuse every mutation regardless of `approve`. */
  readOnly?: boolean;
  readSubpaths?: string[];
  writeSubpaths?: string[];
  /** Kept for compatibility; test protection is mandatory in this integration. */
  testGuard?: boolean;
  limits?: KernelLimits;
  /** Run ms.exec/ms.start in the workspace with persisting effects; only when the host itself is the sandbox (e.g. a throwaway container). */
  directExec?: boolean;
}

interface OpOptions {
  operationId?: string;
  deadlineMs?: number;
  dryRun?: boolean;
}

class OperationError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(completed: CompletedEvent) {
    const code = completed.error?.code ?? "E_PROTOCOL";
    const message = completed.error?.message ?? `operation failed (${completed.status})`;
    super(`${code}: ${message}`);
    this.name = "MsError";
    this.code = code;
    this.hint = completed.error?.hint;
  }
}

/** The adapter's NDJSON channel, for operations it has no typed helper for (`list`, `patch.batch`, `tx.*`). */
class Client extends MsAxiomAdapter {
  raw(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const send = (this as unknown as {
      sendRequest(
        m: string,
        p: Record<string, unknown>,
        s?: AbortSignal,
      ): Promise<{ records: unknown[]; completed: CompletedEvent }>;
    }).sendRequest.bind(this);
    return send(method, params, signal);
  }
}

const DESCRIPTION = [
  "Run a JavaScript program body (`code`); `await` every ms call and `return` only what you need (as JSON). `inputs` is `ms.inputs`.",
  "ms.read(path,{startLine,lineCount}) -> {path,revision,totalLines,text} (text is the exact file content; truncated+nextStartLine when cut; format:'hashline' for tagged lines).",
  "ms.list(path,{recursive}) -> ['file','dir/'] (recursive: files only). ms.search(query,{path,regex,maxMatches}) -> {hits:[{path,line,text}]} (literal unless regex:true). ms.outline(path).",
  "Journaled writes, existing tests and test config protected: ms.edit(path,{oldText,newText}|[...],{expectedRevision}), ms.write(path,text,{expectedRevision}) (new files: no revision), ms.rm, ms.mv, atomic ms.batch([{kind:'edit',path,expectedRevision,oldText,newText}]), ms.undo(). Example: await ms.edit(path, {oldText, newText}, {expectedRevision: (await ms.read(path)).revision}).",
  "ms.exec(cmd,{timeoutMs}) -> {exitCode,output} on a disposable snapshot without network. Long runs: ms.start(cmd), ms.wait(id), ms.tail(id,n), ms.grep(id,pattern).",
].join("\n");

export const MS_SYSTEM_PROMPT_ADDENDUM = [
  "# Code-Mode Workflow (`ms` tool)",
  "- Everything goes through `ms`; never mention `read_file`, `edit`, `write_file`, `apply_patch`, `run_command`, `run_tests`, `list_dir` or `search_code`.",
  "- Two programs, then answer. Program 1 explores: list, search, read every file the hits point at and run the failing test or repro, all at once. Program 2 fixes and verifies: read for the revision, edit, then run the checks and return their result.",
  "- Return only what you need; pass code through `inputs`. Shell runs on a snapshot, so persist with the file API. Never end at a plan.",
].join("\n");

/** Rewrites multi-tool references in a base Axiom system prompt for single-tool `ms` mode and appends code-mode guidance. */
export function buildMsSystemPrompt(baseSystemPrompt: string): string {
  const adapted = baseSystemPrompt
    .replace(/with bash and file tools\./g, "with the programmable `ms` workspace tool.")
    .replace(/with the "edit" or "write_file" tool/g, "using `ms.edit`, `ms.write`, or `ms.batch`")
    .replace(/\buse read_file\b/gi, "use `ms.read`");
  return `${adapted}\n\n${MS_SYSTEM_PROMPT_ADDENDUM}`;
}

export function createMsTool(options: MsToolOptions) {
  const workspaceFd = fs.openSync(fs.realpathSync(options.workspaceRoot), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_CLOEXEC);
  const anchoredRoot = `/proc/${process.pid}/fd/${workspaceFd}`;
  let closed = false;
  const exposedBy = (target: string, mounts: string[]) => {
    let resolved = path.resolve(target);
    const missing: string[] = [];
    while (!fs.existsSync(resolved) && path.dirname(resolved) !== resolved) {
      missing.unshift(path.basename(resolved));
      resolved = path.dirname(resolved);
    }
    resolved = path.join(fs.realpathSync(resolved), ...missing);
    return mounts.some((mount) => {
      const base = fs.realpathSync(mount);
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  };
  const allowWrite = Boolean(options.allowWrite) && options.readOnly !== true;
  let client: Client | undefined;
  let sessionId: string | undefined;
  let connecting: Promise<{ client: Client; sessionId: string }> | undefined;
  /** Live jobs outlive the program that started them; only the session ends them. */
  const jobs = new JobRegistry(path.join(options.stateDir ?? path.join(os.tmpdir(), "ms-axiom"), "jobs", crypto.randomUUID()));

  const connect = async (): Promise<{ client: Client; sessionId: string }> => {
    if (client && sessionId) return { client, sessionId };
    if (connecting) return connecting;
    connecting = (async () => {
    if (!client) {
      const instance = new Client(options.msBin, anchoredRoot, options.stateDir, allowWrite);
      const capabilities: Capabilities = await instance.initialize();
      if (allowWrite && !capabilities.allowWrite) {
        instance.shutdown();
        throw new Error("ms host refused --allow-write; mutations stay unavailable");
      }
      client = instance;
    }
    if (!sessionId) {
      sessionId = await client.openSession({
        allowWrite,
        readSubpaths: options.readSubpaths,
        writeSubpaths: allowWrite ? options.writeSubpaths : undefined,
        testGuard: {},
      });
    }
      return { client, sessionId };
    })();
    try { return await connecting; } finally { connecting = undefined; }
  };

  const gate = async (request: MutationRequest, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw new Error("program cancelled before approval");
    if (!allowWrite) throw new Error(`read-only session: ${request.kind} refused`);
    if (!options.approve) {
      if (options.allowUnapprovedWrites) return;
      const target = request.path ?? request.command ?? request.paths?.join(", ") ?? "workspace";
      throw new Error(`no approver installed: ${request.kind} on ${target} refused`);
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("program cancelled while awaiting approval"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let answer: Awaited<ReturnType<Approve>>;
    try { answer = await Promise.race([options.approve(request), aborted]); }
    finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    if (answer !== "allow") {
      throw new Error(`denied by policy: ${typeof answer === "string" ? answer : request.reason}`);
    }
  };

  const buildApi = (instance: Client, session: string, signal: AbortSignal): Record<string, HostFn> => {
    type Reply = { records: unknown[]; completed: CompletedEvent };
    const unwrap = ({ records, completed }: Reply) => {
      if (completed.status !== "ok") throw new OperationError(completed);
      return { records, result: (completed.result ?? {}) as Record<string, any>, truncated: Boolean(completed.truncated) };
    };

    const call = async (operation: Record<string, unknown>, opts: OpOptions = {}) =>
      unwrap(
        await instance.raw(
          "call",
          { sessionId: session, operationId: opts.operationId, deadlineMs: opts.deadlineMs, operation },
          signal,
        ),
      );

    const cleanRev = (rev: unknown): string | undefined =>
      typeof rev === "string" ? rev.replace(/^rev:/, "") : undefined;
    const requireRev = (rev: unknown): string => {
      const value = cleanRev(rev);
      if (!value) throw new Error("expectedRevision is required for an existing file: ms.edit(path,{oldText,newText},{expectedRevision:(await ms.read(path)).revision})");
      return value;
    };

    /**
     * Mutation gate + idempotency. `run` uses the adapter's typed mutators, never raw `call`: those are the
     * paths that apply the Axiom test-guard before the write reaches the journal.
     */
    const mutate = async (run: (operationId: string) => Promise<Reply>, request: MutationRequest, opts: OpOptions = {}) => {
      await gate(request, signal);
      if (signal.aborted) throw new Error("program cancelled before mutation");
      const operationId = opts.operationId ?? crypto.randomUUID();
      const { result } = unwrap(await run(operationId));
      // The model needs the new revision and the undo handle; before/after hashes, byte deltas and ids it supplied are noise.
      const { afterRevision, beforeRevision: _before, operationId: _op, bytesDelta: _delta, dryRun, ...rest } = result;
      return { ...rest, ...(rest.revision === undefined && typeof afterRevision === "string" && { revision: afterRevision }), ...(dryRun && { dryRun }) };
    };

    const rootAbs = path.resolve(options.workspaceRoot);
    const normalizePath = (p: string): string => {
      if (typeof p !== "string") return p;
      if (!path.isAbsolute(p)) return path.posix.normalize(p.replace(/\\/g, "/"));
      const rel = path.relative(rootAbs, path.resolve(p));
      if (rel === "") return ".";
      if (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
      }
      return p;
    };

    const protectedPath = (p: string) => isTestPath(p) || isTestConfigPath(p);
    const assertNotTest = (p: string) => {
      if (protectedPath(p)) throw new Error(`test-guard: existing tests and test configuration are protected: ${p}`);
    };
    const timeoutValue = (value: unknown, fallback: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
        throw new Error("timeoutMs must be an integer between 0 and 2147483647");
      }
      return value;
    };

    const startSandbox = async (command: string | string[], timeoutMs?: number) => {
      if (options.directExec) return jobs.start(Array.isArray(command) ? command.join(" ") : command, { cwd: options.workspaceRoot, timeoutMs });
      const systemDirs = ["/usr", "/bin", "/lib", "/lib64"].filter(fs.existsSync);
      if ([options.workspaceRoot, options.stateDir].some((p) => p && exposedBy(p, systemDirs))) {
        throw new Error("sandbox unavailable: workspace or state is inside a system mount");
      }
      const roots = options.readSubpaths?.length ? options.readSubpaths : ["."];
      const entries: Array<{ path: string; kind: string }> = [];
      for (const root of roots) {
        const listed = await call({ kind: "list", path: root, recursive: true, includeHidden: true, respectIgnore: true, maxEntries: 100_000 });
        if (listed.truncated) throw new Error("cannot create complete sandbox snapshot: listing was truncated");
        entries.push(...listed.records as Array<{ path: string; kind: string }>);
      }
      const snapshot = createSnapshot(workspaceFd, entries, command);
      try {
        if (signal.aborted) throw new Error("program cancelled before shell launch");
        return jobs.start(Array.isArray(command) ? command.join(" ") : command, {
          cwd: os.tmpdir(), timeoutMs, file: "bwrap", args: sandboxCommand(snapshot, command),
          env: { PATH: process.env.PATH }, onFinish: () => fs.rmSync(snapshot, { recursive: true, force: true }),
        });
      } catch (error) {
        fs.rmSync(snapshot, { recursive: true, force: true });
        throw error;
      }
    };

    const api: Record<string, HostFn> = {
      read: async (rawPath: string, opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        const hashline = opts.format === "hashline";
        const startLine = opts.startLine ?? 1;
        const { records, result, truncated: serverTruncated } = await call({
          kind: "read",
          path: targetPath,
          startLine,
          lineCount: opts.lineCount ?? 400,
          format: hashline ? "hashline" : "json",
        });
        const totalLines = typeof result.totalLines === "number" ? result.totalLines : null;
        const lines = (records as Array<{ text: string }>).map((record) => record.text);
        const hashText = String(result.hashline ?? "");
        const returnedCount = hashline ? (totalLines === 0 ? 0 : Math.max(0, hashText.split("\n").length - 1)) : lines.length;
        const endLine = returnedCount > 0 ? startLine + returnedCount - 1 : 0;
        const hasMore = totalLines !== null && (returnedCount > 0 ? endLine < totalLines : startLine <= totalLines);
        const truncated = Boolean(serverTruncated) || hasMore;
        // Plain text is the file's own bytes for the window, so `text.replace(a, b)` round-trips through ms.write.
        const eol = result.eol === "crlf" ? "\r\n" : "\n";
        const lastLineOpen = endLine === totalLines && result.hasTrailingNewline === false;
        const text = hashline ? hashText : lines.map((line, i) => (i === lines.length - 1 && lastLineOpen ? line : line + eol)).join("");
        return {
          path: result.path ?? targetPath,
          revision: result.fileRevision ?? null,
          totalLines,
          ...(truncated && { truncated, startLine: returnedCount > 0 ? startLine : 0, endLine, nextStartLine: returnedCount > 0 ? endLine + 1 : startLine }),
          ...(result.hasBom && { hasBom: true }),
          text,
        };
      },

      list: async (rawPath = "", opts: Record<string, any> = {}) => {
        const { records, truncated } = await call({
          kind: "list",
          path: normalizePath(rawPath),
          recursive: opts.recursive,
          maxEntries: opts.maxEntries,
          includeHidden: opts.includeHidden,
          respectIgnore: opts.respectIgnore,
        });
        if (truncated) throw new Error("listing truncated; narrow the path or increase maxEntries before drawing conclusions");
        const entries = records as Array<{ path: string; kind: string }>;
        const kept = opts.includeCache || opts.includeHidden
          ? entries
          : entries.filter((e) => !/(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.pyc$/.test(e.path));
        // Recursive listings imply their directories; only a flat listing names them (with a trailing '/').
        return kept.flatMap((e) => (e.kind !== "dir" ? [e.path] : opts.recursive ? [] : [`${e.path}/`]));
      },

      search: async (query: string, opts: Record<string, any> = {}) => {
        const maxMatches = opts.maxMatches ?? 60;
        const { records, truncated } = await call({
          kind: "search",
          query,
          path: typeof opts.path === "string" ? normalizePath(opts.path) : opts.path,
          regex: opts.regex,
          caseSensitive: opts.caseSensitive,
          maxMatches,
          contextLines: opts.contextLines,
        });
        const hits = (records as Array<Record<string, any>>).map((record) => {
          const rawText = String(record.lineText ?? "");
          let text = rawText;
          let textTruncated = false;
          const offset = record.startByte - record.lineStartByte;
          if (rawText.length > 200 && Number.isSafeInteger(offset) && offset >= 0) {
            const bytes = Buffer.from(rawText, "utf8");
            if (offset <= bytes.length) {
              const matchIndex = bytes.subarray(0, offset).toString("utf8").length;
              let start = Math.max(0, Math.min(rawText.length - 200, matchIndex - 60));
              if (start > 0 && /[\uDC00-\uDFFF]/.test(rawText[start]!)) start--;
              let end = Math.min(rawText.length, start + 200);
              if (end < rawText.length && /[\uDC00-\uDFFF]/.test(rawText[end]!)) end--;
              text = `${start ? "…" : ""}${rawText.slice(start, end)}${end < rawText.length ? "…" : ""}`;
              textTruncated = start > 0 || end < rawText.length;
            }
          }
          return { path: record.path, line: record.lineNumber, text, ...(textTruncated && { textTruncated }) };
        });
        return { hits, ...(truncated && { truncated: true }) };
      },

      outline: async (rawPath = ".", opts: Record<string, any> = {}) => {
        const { records } = await call({
          kind: "outline",
          path: normalizePath(rawPath),
          maxFiles: opts.maxFiles,
          maxSymbolsPerFile: opts.maxSymbolsPerFile ?? opts.maxSymbols,
        });
        return records;
      },

      context: async (pathOrSymbol: string, opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(typeof opts.path === "string" ? opts.path : pathOrSymbol);
        const symbol = typeof opts.path === "string" ? (opts.symbol ?? pathOrSymbol) : opts.symbol;
        const { result } = await call({
          kind: "context_bundle",
          path: targetPath,
          line: opts.line,
          symbol,
          radius: opts.radius,
        });
        return result;
      },

      tx: async (opts: Record<string, any> = {}) => {
        const { records } = await call({
          kind: "tx.list",
          operationId: opts.operationId,
          limit: opts.limit,
          includeUndone: opts.includeUndone,
        });
        return records;
      },

      write: async (rawPath: string, text: string, opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        if (protectedPath(targetPath) && cleanRev(opts.expectedRevision)) throw new Error(`test-guard: existing tests and test configuration are protected: ${targetPath}`);
        if (typeof text !== "string") {
          throw new Error(`ms.write on ${targetPath} requires string text (got ${typeof text})`);
        }
        return mutate(
          (operationId) =>
            instance.writeFile(session, operationId, targetPath, text, {
              createIfMissing: opts.createIfMissing ?? true,
              overwrite: false,
              expectedRevision: cleanRev(opts.expectedRevision),
              dryRun: opts.dryRun,
            }),
          { kind: "write", path: targetPath, reason: `writes ${targetPath}` },
          opts,
        );
      },

      edit: async (rawPath: string, edits: EditSpec | EditSpec[], opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        assertNotTest(targetPath);
        // Models often put the revision inside the edit spec(s). Hoist it; it is still required and still checked by the runtime.
        const specs: Array<EditSpec & { expectedRevision?: string }> = Array.isArray(edits) ? edits : [edits];
        const specRevisions = [...new Set(specs.map((e) => cleanRev(e?.expectedRevision)).filter(Boolean))];
        if (specRevisions.length > 1) throw new Error("ms.edit: edits name different expectedRevision values; one file has one revision");
        const expectedRevision = requireRev(opts.expectedRevision ?? specRevisions[0]);
        const cleanSpecs = specs.map(({ expectedRevision: _rev, ...spec }) => spec as EditSpec);
        return mutate(
          (operationId) =>
            instance.editFile(session, operationId, targetPath, cleanSpecs, {
              expectedRevision,
              dryRun: opts.dryRun,
            }),
          { kind: "edit", path: targetPath, reason: `edits ${targetPath}` },
          opts,
        );
      },

      batch: async (operations: Array<Record<string, any>>, opts: Record<string, any> = {}) => {
        const normalized = operations.map((op) => {
          const kind = String(op.kind ?? (op.oldText !== undefined || op.edits !== undefined ? "edit" : ""));
          let expectedRevision = cleanRev(op.expectedRevision);
          const opPath = typeof op.path === "string" ? normalizePath(op.path) : op.path;
          if (kind === "edit" || kind === "patch" || kind === "rm" || kind === "delete" || kind === "delete_file") assertNotTest(String(opPath ?? ""));
          if (kind === "mv" || kind === "rename" || kind === "rename_file") { assertNotTest(normalizePath(String(op.from ?? ""))); assertNotTest(normalizePath(String(op.to ?? ""))); }
          if (kind === "edit") {
            expectedRevision = requireRev(expectedRevision);
            const rawEdits =
              op.edits ??
              (op.oldText !== undefined || op.startLine !== undefined || op.startByte !== undefined
                ? {
                    oldText: op.oldText,
                    newText: op.newText,
                    replaceAll: op.replaceAll,
                    startLine: op.startLine,
                    endLine: op.endLine,
                    startTag: op.startTag,
                    endTag: op.endTag,
                    replacement: op.replacement,
                    startByte: op.startByte,
                    endByte: op.endByte,
                    expectedText: op.expectedText,
                  }
                : undefined);
            const edits = rawEdits === undefined ? [] : Array.isArray(rawEdits) ? rawEdits : [rawEdits];
            if (edits.length === 0) {
              throw new Error(`ms.batch edit on ${String(opPath ?? "?")} requires non-empty edits`);
            }
            return { kind: "edit", path: opPath, expectedRevision, edits, dryRun: op.dryRun };
          }
          if (kind === "write" || kind === "write_file") {
            if (protectedPath(String(opPath)) && expectedRevision) throw new Error(`test-guard: existing tests and test configuration are protected: ${String(opPath)}`);
            const content = op.content ?? op.text;
            if (typeof content !== "string") {
              throw new Error(`ms.batch write_file on ${String(opPath ?? "?")} requires string content (got ${typeof content}; check ms.inputs keys)`);
            }
            return {
              kind: "write_file",
              path: opPath,
              content,
              createIfMissing: op.createIfMissing ?? true,
              overwrite: false,
              expectedRevision,
              dryRun: op.dryRun,
            };
          }
          if (kind === "rm" || kind === "delete" || kind === "delete_file") {
            expectedRevision = requireRev(expectedRevision);
            return { kind: "delete_file", path: opPath, expectedRevision, dryRun: op.dryRun };
          }
          if (kind === "mv" || kind === "rename" || kind === "rename_file") {
            expectedRevision = requireRev(expectedRevision);
            if (op.overwrite) throw new Error("rename cannot overwrite an existing destination");
            return {
              kind: "rename_file",
              from: normalizePath(String(op.from ?? "")),
              to: normalizePath(String(op.to ?? "")),
              expectedRevision,
              overwrite: false,
              dryRun: op.dryRun,
            };
          }
          if (kind === "patch" && expectedRevision !== undefined) {
            return { ...op, path: opPath, expectedRevision };
          }
          return typeof op.path === "string" ? { ...op, path: opPath } : op;
        });
        const paths = normalized.map((operation) => String(operation.path ?? operation.from ?? ""));
        return mutate(
          (operationId) => instance.batch(session, operationId, normalized, { dryRun: opts.dryRun }),
          { kind: "batch", paths, reason: `atomic batch over ${paths.length} file(s)` },
          opts,
        );
      },

      rm: async (rawPath: string, opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        assertNotTest(targetPath);
        const expectedRevision = requireRev(opts.expectedRevision);
        return mutate(
          (operationId) =>
            instance.deleteFile(session, operationId, targetPath, {
              ...opts,
              expectedRevision,
            }),
          { kind: "delete", path: targetPath, reason: `deletes ${targetPath}` },
          opts,
        );
      },

      mv: async (rawFrom: string, rawTo: string, opts: Record<string, any> = {}) => {
        const from = normalizePath(rawFrom);
        const to = normalizePath(rawTo);
        assertNotTest(from);
        assertNotTest(to);
        const expectedRevision = requireRev(opts.expectedRevision);
        if (opts.overwrite) throw new Error("rename cannot overwrite an existing destination");
        return mutate(
          (operationId) =>
            instance.renameFile(session, operationId, from, to, {
              ...opts,
              expectedRevision,
              overwrite: false,
            }),
          { kind: "rename", path: `${from} -> ${to}`, reason: `renames ${from} to ${to}` },
          opts,
        );
      },

      undo: async (opts: Record<string, any> = {}) => {
        const { records, truncated } = await call({ kind: "tx.list", includeUndone: false, limit: 10_000 });
        const latest = (records as Array<Record<string, any>>).find((tx) => tx.kind !== "undo" && tx.state === "committed");
        if (truncated || !latest) throw new Error("cannot safely identify undo transaction");
        assertNotTest(normalizePath(String(latest.path ?? "")));
        if (latest.kind === "rename") throw new Error("test-guard: undo of rename is unavailable because destination is not exposed");
        if (opts.transactionId && opts.transactionId !== latest.transactionId) throw new Error("transaction is not latest undoable transaction");
        return mutate(
          (operationId) => instance.undo(session, operationId, latest.transactionId),
          { kind: "undo", reason: `undoes transaction ${opts.transactionId ?? "latest"}` },
          opts,
        );
      },

      exec: async (command: string | string[], opts: Record<string, any> = {}) => {
        const timeoutMs = timeoutValue(opts.timeoutMs, 60_000);
        if (!isReadOnlyInspectionCommand(command)) {
          await gate({
            kind: "exec",
            command: Array.isArray(command) ? command.join(" ") : command,
            reason: "runs a shell command that may write files",
          }, signal);
        }
        const job = await startSandbox(command, timeoutMs);
        const onAbort = () => jobs.kill(job.id);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (signal.aborted) onAbort();
          let status = jobs.statusOf(job.id);
          while (status.running) status = await jobs.wait(job.id, 1000);
          const output = jobs.output(job.id, { maxBytes: opts.maxBytes ?? 4096 });
          // Only the fields that carry information: a clean run costs {exitCode, output} and nothing else.
          const failed = output.exitCode !== 0;
          return {
            exitCode: output.exitCode,
            output: output.text,
            ...(status.timedOut && { timedOut: true }),
            ...(output.truncated && { truncated: true }),
            ...((output.truncated || failed) && { logId: job.id }),
          };
        } finally { signal.removeEventListener("abort", onAbort); }
      },

      log: async (id: string, opts: Record<string, any> = {}) => {
        if (typeof id !== "string" || !id.trim()) {
          throw new Error("ms.log: logId is required (ms.exec only sets logId for large or failing runs; read res.output when logId is undefined)");
        }
        if (!opts.grep) return jobs.tail(id, opts.tail).lines;
        const result = await jobs.grep(id, opts.grep, {}, signal);
        return result.matches.join("\n") + (result.truncated ? "\n… log search incomplete …" : "");
      },

      /**
       * Async job control. `start` returns a handle immediately, the handle survives the program,
       * and the raw log is on disk so `tail`/`grep` return exactly the bytes asked for.
       */
      start: async (command: string, opts: Record<string, any> = {}) => {
        const timeoutMs = timeoutValue(opts.timeoutMs, 600_000);
        if (!isReadOnlyInspectionCommand(command)) {
          await gate({ kind: "exec", command, reason: "starts a shell command that may write files" }, signal);
        }
        if (opts.env) throw new Error("custom environment is unavailable in sandboxed jobs");
        return startSandbox(command, timeoutMs);
      },
      poll: async (id: string) => jobs.statusOf(id),
      jobs: async () => jobs.list(),
      tail: async (id: string, n = 40) => jobs.tail(id, n),
      head: async (id: string, n = 40) => jobs.head(id, n),
      grep: async (id: string, pattern: string, opts: Record<string, any> = {}) =>
        jobs.grep(id, pattern, { context: opts.context, max: opts.max }, signal),
      wait: async (id: string, opts: Record<string, any> = {}) => jobs.wait(id, opts.timeoutMs, signal),
      output: async (id: string, opts: Record<string, any> = {}) => jobs.output(id, { maxBytes: opts.maxBytes }),
      kill: async (id: string, opts: Record<string, any> = {}) => {
        await gate({ kind: "exec", command: `kill ${id}`, reason: `stops job ${id}` }, signal);
        return jobs.kill(id, opts.signal);
      },
    };
    if (!allowWrite) for (const name of ["write", "edit", "batch", "rm", "mv", "undo", "exec", "start", "kill"]) delete api[name];
    return api;
  };

  const description = options.directExec
    ? DESCRIPTION.replace(" on a disposable snapshot without network", " in the workspace (effects persist)")
    : DESCRIPTION;
  return {
    name: "ms",
    description,
    parameters: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "JavaScript program body",
        },
        inputs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Strings exposed as ms.inputs",
        },
      },
      required: ["code"],
    },
    isReadOnly: false,

    toDefinition() {
      return {
        name: "ms",
        description,
        parameters: { type: "object", properties: this.parameters.properties, required: ["code"] },
      };
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) return "Error: `code` is required: a JavaScript program body using the `ms` capability table.";
      const guestDirs = ["/lib", "/lib64", "/usr/lib"].filter(fs.existsSync);
      if ([options.workspaceRoot, options.stateDir].some((p) => p && exposedBy(p, guestDirs))) {
        return "Error: sandbox unavailable: workspace or state is inside a system mount";
      }
      const inputs: Record<string, string> = {};
      if (args.inputs && typeof args.inputs === "object" && !Array.isArray(args.inputs)) {
        for (const [k, v] of Object.entries(args.inputs as Record<string, unknown>)) {
          inputs[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }

      let connection: { client: Client; sessionId: string };
      try {
        connection = await connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: workspace runtime unavailable: ${message}`;
      }

      const run = await runProgram(
        code,
        (signal) => buildApi(connection.client, connection.sessionId, signal),
        options.limits,
        inputs,
        !options.directExec,
      );
      const tail = `${run.calls} call${run.calls === 1 ? "" : "s"} · ${run.durationMs}ms`;
      const logs = run.logs.length ? `\nlogs:\n${run.logs.join("\n")}` : "";
      return cap(run.ok ? `ok · ${tail}\n${run.output}${logs}` : `Error: ${run.output}\ncalls: ${tail}${logs}`, options.limits?.maxResultBytes ?? DEFAULT_LIMITS.maxResultBytes);
    },

    /** Drops the NDJSON child process, kills live jobs, releases the workspace lock. */
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await jobs.close();
      client?.shutdown();
      fs.closeSync(workspaceFd);
      client = undefined;
      sessionId = undefined;
    },
  };
}

export type MsTool = ReturnType<typeof createMsTool>;
