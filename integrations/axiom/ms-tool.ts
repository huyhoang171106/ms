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
import os from "node:os";
import path from "node:path";
import {
  type Capabilities,
  type CompletedEvent,
  type EditSpec,
  MsAxiomAdapter,
  isReadOnlyInspectionCommand,
} from "../../examples/axiom_adapter.js";
import { JobRegistry } from "./jobs.js";
import { type HostFn, type KernelLimits, runProgram } from "./kernel.js";

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
  testGuard?: boolean;
  limits?: KernelLimits;
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
  "Workspace tool: pass a JavaScript `code` program whose global `ms` is the async workspace API (`await` every `ms.*` call). Standard JS only inside `code` (no Node/Bun globals — run scripts via `ms.exec`). Only `return` and `console.log` reach the conversation; filter and aggregate in JS.",
  "",
  "Paths & Inputs:",
  "- Use workspace-relative paths (`'.'`, `'src/app.js'`); paths outside the workspace root are rejected.",
  "- Optional `inputs` (`{ [key]: string }`) exposes raw unescaped strings as `ms.inputs` inside `code` (no JS template escaping needed).",
  "",
  "Read:",
  "- `ms.read(path, {startLine, lineCount, format})` -> {path, revision, totalLines, startLine, endLine, truncated, nextStartLine, text}. Default lineCount=400; `format` is 'hashline' (default) or 'json' (compact for large files).",
  "- `ms.list(path, {recursive, maxEntries, includeHidden, includeCache, respectIgnore})` -> [{path, kind, sizeBytes}]",
  "- `ms.search(query, {path, regex, caseSensitive, maxMatches, contextLines})` -> {hits: [{path, line, text, tag}], count, truncated} (default maxMatches=60)",
  "- `ms.outline(path, {maxFiles, maxSymbolsPerFile})` | `ms.context(path, {line, symbol, radius})` | `ms.tx({operationId, limit, includeUndone})`",
  "",
  "Write (journaled, undoable, test-guarded):",
  "- `ms.write(path, text, {createIfMissing, overwrite, expectedRevision, dryRun})` -> {revision, ...}",
  "- `ms.edit(path, edits, {expectedRevision, dryRun})` -> {revision, ...}; `edits` = `{oldText, newText, replaceAll?}` | `{startLine, endLine, replacement}` | array",
  "- `ms.batch(operations, {dryRun})` -> atomic all-or-nothing batch (test-guarded per op). Items: `{kind:'edit', path, edits:[...], expectedRevision?}`, `{kind:'write_file', path, content}`, `{kind:'delete_file', path}`, `{kind:'rename_file', from, to}`.",
  "- `ms.rm(path, opts)` | `ms.mv(from, to, opts)` | `ms.undo({transactionId})`",
  "",
  "Shell & Background Jobs:",
  "- `ms.exec(command, {timeoutMs})` -> {exitCode, output, logId?}. Pass argv array `['bun', '-e', js]` or `['python3', '-c', py]` to skip `/bin/sh`; pass string for shell pipelines. Check `if (res.logId)` before `ms.log(res.logId, {tail, grep})`, else read `res.output`.",
  "- `ms.start(command, {timeoutMs, env})` -> {id, pid, running} (lives across calls); `ms.wait(id, {timeoutMs})`, `ms.poll(id)`, `ms.jobs()`, `ms.tail/head(id, n)`, `ms.output(id)`, `ms.grep(id, pat)`, `ms.kill(id)`.",
].join("\n");

export const MS_SYSTEM_PROMPT_ADDENDUM = [
  "# Code-Mode Workflow (`ms` tool)",
  "- Operate exclusively via `ms` (`await ms.*`). Never mention legacy tool names (`read_file`, `edit`, `write_file`, `apply_patch`, `run_command`, `run_tests`, `list_dir`, `search_code`).",
  "- Batch Turn-1 discovery in one call: `ms.list`, configs (`package.json`, `tsconfig.json`, `pyproject.toml`), `ms.search`/`ms.outline`, and `ms.read` (use `format: 'json'` on large files).",
  "- Edit cleanly: pass raw code strings in `inputs` (`ms.batch(Object.entries(ms.inputs).map(([path, content]) => ({kind:'write_file', path, content})))`) whenever files contain backticks/`${}` instead of manual placeholder escaping. Verify `calls > 0` before claiming writes landed.",
  "- Verify via `ms.exec(['bun', '-e', code])` or `ms.exec('...')` (`Bun`/`fs`/`process` only exist inside `ms.exec`, never inside `code`) and check remaining callers with `ms.search`. Never end at a plan.",
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
  const allowWrite = Boolean(options.allowWrite) && options.readOnly !== true;
  let client: Client | undefined;
  let sessionId: string | undefined;
  /** Live jobs outlive the program that started them; only the session ends them. */
  const jobs = new JobRegistry(path.join(options.stateDir ?? path.join(os.tmpdir(), "ms-axiom"), "jobs"));

  const connect = async (): Promise<{ client: Client; sessionId: string }> => {
    if (!client) {
      const instance = new Client(options.msBin, options.workspaceRoot, options.stateDir, allowWrite);
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
        testGuard: options.testGuard === false ? false : {},
      });
    }
    return { client, sessionId };
  };

  const gate = async (request: MutationRequest): Promise<void> => {
    if (!allowWrite) throw new Error(`read-only session: ${request.kind} refused`);
    if (!options.approve) {
      if (options.allowUnapprovedWrites) return;
      const target = request.path ?? request.command ?? request.paths?.join(", ") ?? "workspace";
      throw new Error(`no approver installed: ${request.kind} on ${target} refused`);
    }
    const answer = await options.approve(request);
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

    /**
     * Mutation gate + idempotency. `run` uses the adapter's typed mutators, never raw `call`: those are the
     * paths that apply the Axiom test-guard before the write reaches the journal.
     */
    const mutate = async (run: (operationId: string) => Promise<Reply>, request: MutationRequest, opts: OpOptions = {}) => {
      await gate(request);
      const operationId = opts.operationId ?? crypto.randomUUID();
      const { result } = unwrap(await run(operationId));
      return {
        ...result,
        ...(typeof result.afterRevision === "string" && result.revision === undefined ? { revision: result.afterRevision } : {}),
        operationId,
      };
    };

    const rootAbs = path.resolve(options.workspaceRoot);
    const normalizePath = (p: string): string => {
      if (typeof p !== "string" || !path.isAbsolute(p)) return p;
      const rel = path.relative(rootAbs, path.resolve(p));
      if (rel === "") return ".";
      if (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
      }
      return p;
    };

    return {
      read: async (rawPath: string, opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        const format = opts.format === "json" ? "json" : "hashline";
        const startLine = opts.startLine ?? 1;
        const { records, result, truncated: serverTruncated } = await call({
          kind: "read",
          path: targetPath,
          startLine,
          lineCount: opts.lineCount ?? 400,
          format,
        });
        const text =
          format === "hashline"
            ? (result.hashline ?? "")
            : (records as Array<{ text: string }>).map((record) => record.text).join("\n");
        const totalLines = typeof result.totalLines === "number" ? result.totalLines : null;
        const returnedCount =
          format === "hashline"
            ? (totalLines === 0 ? 0 : Math.max(0, text.split("\n").length - 1))
            : records.length;
        const endLine = returnedCount > 0 ? startLine + returnedCount - 1 : 0;
        const truncated = Boolean(serverTruncated) || (returnedCount > 0 && totalLines !== null && endLine < totalLines);
        return {
          path: result.path ?? targetPath,
          revision: result.fileRevision ?? null,
          totalLines,
          startLine: returnedCount > 0 ? startLine : 0,
          endLine,
          truncated,
          nextStartLine: truncated ? endLine + 1 : null,
          eol: result.eol ?? null,
          text,
        };
      },

      list: async (rawPath = "", opts: Record<string, any> = {}) => {
        const { records } = await call({
          kind: "list",
          path: normalizePath(rawPath),
          recursive: opts.recursive,
          maxEntries: opts.maxEntries,
          includeHidden: opts.includeHidden,
          respectIgnore: opts.respectIgnore,
        });
        const entries = records as Array<{ path: string; kind: string; sizeBytes: number }>;
        if (opts.includeCache || opts.includeHidden) return entries;
        return entries.filter((e) => !/(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.pyc$/.test(e.path));
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
          return {
            path: record.path,
            line: record.lineNumber,
            text: rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText,
            tag: record.lineTag,
          };
        });
        return { hits, count: hits.length, truncated: Boolean(truncated) };
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
        if (typeof text !== "string") {
          throw new Error(`ms.write on ${targetPath} requires string text (got ${typeof text})`);
        }
        return mutate(
          (operationId) =>
            instance.writeFile(session, operationId, targetPath, text, {
              createIfMissing: opts.createIfMissing ?? true,
              overwrite: opts.overwrite ?? true,
              expectedRevision: cleanRev(opts.expectedRevision),
              dryRun: opts.dryRun,
            }),
          { kind: "write", path: targetPath, reason: `writes ${targetPath}` },
          opts,
        );
      },

      edit: async (rawPath: string, edits: EditSpec | EditSpec[], opts: Record<string, any> = {}) => {
        const targetPath = normalizePath(rawPath);
        return mutate(
          (operationId) =>
            instance.editFile(session, operationId, targetPath, Array.isArray(edits) ? edits : [edits], {
              expectedRevision: cleanRev(opts.expectedRevision),
              dryRun: opts.dryRun,
            }),
          { kind: "edit", path: targetPath, reason: `edits ${targetPath}` },
          opts,
        );
      },

      batch: async (operations: Array<Record<string, any>>, opts: Record<string, any> = {}) => {
        const normalized = operations.map((op) => {
          const kind = String(op.kind ?? "");
          const expectedRevision = cleanRev(op.expectedRevision);
          const opPath = typeof op.path === "string" ? normalizePath(op.path) : op.path;
          if (kind === "edit") {
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
            const content = op.content ?? op.text;
            if (typeof content !== "string") {
              throw new Error(`ms.batch write_file on ${String(opPath ?? "?")} requires string content (got ${typeof content}; check ms.inputs keys)`);
            }
            return {
              kind: "write_file",
              path: opPath,
              content,
              createIfMissing: op.createIfMissing ?? true,
              overwrite: op.overwrite ?? true,
              expectedRevision,
              dryRun: op.dryRun,
            };
          }
          if (kind === "rm" || kind === "delete" || kind === "delete_file") {
            return { kind: "delete_file", path: opPath, expectedRevision, dryRun: op.dryRun };
          }
          if (kind === "mv" || kind === "rename" || kind === "rename_file") {
            return {
              kind: "rename_file",
              from: normalizePath(String(op.from ?? "")),
              to: normalizePath(String(op.to ?? "")),
              expectedRevision,
              overwrite: op.overwrite,
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
        return mutate(
          (operationId) =>
            instance.deleteFile(session, operationId, targetPath, {
              ...opts,
              expectedRevision: cleanRev(opts.expectedRevision),
            }),
          { kind: "delete", path: targetPath, reason: `deletes ${targetPath}` },
          opts,
        );
      },

      mv: async (rawFrom: string, rawTo: string, opts: Record<string, any> = {}) => {
        const from = normalizePath(rawFrom);
        const to = normalizePath(rawTo);
        return mutate(
          (operationId) =>
            instance.renameFile(session, operationId, from, to, {
              ...opts,
              expectedRevision: cleanRev(opts.expectedRevision),
            }),
          { kind: "rename", path: `${from} -> ${to}`, reason: `renames ${from} to ${to}` },
          opts,
        );
      },

      undo: async (opts: Record<string, any> = {}) =>
        mutate(
          (operationId) => instance.undo(session, operationId, opts.transactionId),
          { kind: "undo", reason: `undoes transaction ${opts.transactionId ?? "latest"}` },
          opts,
        ),

      exec: async (command: string | string[], opts: Record<string, any> = {}) => {
        if (!isReadOnlyInspectionCommand(command)) {
          await gate({
            kind: "exec",
            command: Array.isArray(command) ? command.join(" ") : command,
            reason: "runs a shell command that may write files",
          });
        }
        return instance.exec(command, { sessionId: session, timeoutMs: opts.timeoutMs, kind: opts.kind, signal });
      },

      log: async (id: string, opts: Record<string, any> = {}) => {
        if (typeof id !== "string" || !id.trim()) {
          throw new Error("ms.log: logId is required (ms.exec only sets logId for large or failing runs; read res.output when logId is undefined)");
        }
        return instance.readLog(id, { tail: opts.tail, grep: opts.grep });
      },

      /**
       * Async job control. `start` returns a handle immediately, the handle survives the program,
       * and the raw log is on disk so `tail`/`grep` return exactly the bytes asked for.
       */
      start: async (command: string, opts: Record<string, any> = {}) => {
        if (!isReadOnlyInspectionCommand(command)) {
          await gate({ kind: "exec", command, reason: "starts a shell command that may write files" });
        }
        return jobs.start(command, {
          cwd: options.workspaceRoot,
          timeoutMs: opts.timeoutMs,
          env: opts.env ? { ...process.env, ...opts.env } : undefined,
        });
      },
      poll: async (id: string) => jobs.statusOf(id),
      jobs: async () => jobs.list(),
      tail: async (id: string, n = 40) => jobs.tail(id, n),
      head: async (id: string, n = 40) => jobs.head(id, n),
      grep: async (id: string, pattern: string, opts: Record<string, any> = {}) =>
        jobs.grep(id, pattern, { context: opts.context, max: opts.max }),
      wait: async (id: string, opts: Record<string, any> = {}) => jobs.wait(id, opts.timeoutMs),
      output: async (id: string, opts: Record<string, any> = {}) => jobs.output(id, { maxBytes: opts.maxBytes }),
      kill: async (id: string, opts: Record<string, any> = {}) => {
        await gate({ kind: "exec", command: `kill ${id}`, reason: `stops job ${id}` });
        return jobs.kill(id, opts.signal);
      },
    };
  };

  return {
    name: "ms",
    description: DESCRIPTION,
    parameters: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "JavaScript program body. Top-level await and return are allowed; `ms` is the capability table.",
        },
        inputs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional string map exposed as `ms.inputs` inside `code`.",
        },
      },
      required: ["code"],
    },
    isReadOnly: false,

    toDefinition() {
      return {
        name: "ms",
        description: DESCRIPTION,
        parameters: { type: "object", properties: this.parameters.properties, required: ["code"] },
      };
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) return "Error: `code` is required: a JavaScript program body using the `ms` capability table.";
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
      );
      const tail = `${run.calls} call${run.calls === 1 ? "" : "s"} · ${run.durationMs}ms`;
      const logs = run.logs.length ? `\nlogs:\n${run.logs.join("\n")}` : "";
      return run.ok ? `ok · ${tail}\n${run.output}${logs}` : `Error: ${run.output}\ncalls: ${tail}${logs}`;
    },

    /** Drops the NDJSON child process, kills live jobs, releases the workspace lock. */
    async close(): Promise<void> {
      await jobs.close();
      client?.shutdown();
      client = undefined;
      sessionId = undefined;
    },
  };
}

export type MsTool = ReturnType<typeof createMsTool>;
