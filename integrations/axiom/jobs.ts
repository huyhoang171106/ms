/**
 * Live shell jobs, after Unharnessed's `bash()`: start returns at once, the handle outlives the cell,
 * and the model reads the bytes it needs instead of accepting a distilled guess.
 *
 * The tool instance is the kernel here: a job started in one program is still there in the next one,
 * so `start` -> end the turn -> `tail` costs two calls instead of one blocked call plus a timeout.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import path from "node:path";

/** Keep the boundaries of the stream without holding all of it; the full log stays on disk. */
const HEAD_CAP = 64 * 1024;
const TAIL_CAP = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const TERM_GRACE_MS = 500;
const KILL_WAIT_MS = 2_000;
const MAX_LIVE_JOBS = 16;
const LOG_HEAD_CAP = 512 * 1024;
const LOG_TAIL_CAP = 512 * 1024;

export interface JobStatus {
  id: string;
  command: string;
  pid: number | undefined;
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  lines: number;
  bytes: number;
  logPath: string;
}

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  timedOut: boolean;
  bytes: number;
  lines: number;
  logPath: string;
  head: string[];
  headBytes: number;
  tail: string[];
  tailBytes: number;
  streams: Record<"stdout" | "stderr", { pending: string; decoder: StringDecoder }>;
  outputLoss: boolean;
  logBytes: number;
  rawBytes: number;
  rawTail: Buffer;
  onFinish?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
}

const ANSI = /\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const GREP_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
try {
  const regex = new RegExp(workerData.pattern);
  const lines = workerData.text.split('\n');
  const matches = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    const from = Math.max(0, i - workerData.context);
    const to = Math.min(lines.length - 1, i + workerData.context);
    for (let j = from; j <= to; j++) matches.push((j + 1) + ': ' + lines[j]);
    i = to;
    if (matches.length >= workerData.max) { truncated = true; break; }
  }
  parentPort.postMessage({ matches: matches.slice(0, workerData.max), truncated });
} catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
`;

function pushLine(job: Job, line: string): void {
  const bytes = Buffer.byteLength(line, "utf8") + 1;
  job.bytes += bytes;
  job.lines += 1;
  if (job.headBytes < HEAD_CAP) {
    job.head.push(line);
    job.headBytes += bytes;
  }
  job.tail.push(line);
  job.tailBytes += bytes;
  while (job.tailBytes > TAIL_CAP && job.tail.length > 1) {
    const dropped = job.tail.shift()!;
    job.tailBytes -= Buffer.byteLength(dropped, "utf8") + 1;
  }
}

function ingest(job: Job, chunk: Buffer, stream: "stdout" | "stderr"): void {
  // Synchronous append: `grep` can run while the job is still writing, and a buffered stream would
  // hand back a log missing its newest lines. One write syscall per chunk is the cheaper trade.
  const remaining = Math.max(0, LOG_HEAD_CAP - job.logBytes);
  if (remaining) {
    const kept = chunk.subarray(0, remaining);
    appendFileSync(job.logPath, kept);
    job.logBytes += kept.length;
  }
  job.rawBytes += chunk.length;
  job.rawTail = Buffer.concat([job.rawTail, chunk]).subarray(-LOG_TAIL_CAP);
  const state = job.streams[stream];
  const text = state.pending + state.decoder.write(chunk).replace(ANSI, "");
  const parts = text.split("\n");
  state.pending = parts.pop() ?? "";
  if (state.pending.length > TAIL_CAP) {
    state.pending = `${state.pending.slice(0, HEAD_CAP / 2)}\n… output line truncated …\n${state.pending.slice(-TAIL_CAP / 2)}`;
    job.outputLoss = true;
  }
  for (const line of parts) pushLine(job, line);
}

function finish(job: Job): void {
  if (job.endedAt !== undefined) return;
  job.endedAt = Date.now();
  for (const state of Object.values(job.streams)) {
    const pending = state.pending + state.decoder.end();
    if (pending) for (const line of pending.split("\n")) pushLine(job, line);
    state.pending = "";
  }
  if (job.timer) clearTimeout(job.timer);
  if (job.rawBytes > LOG_HEAD_CAP) {
    const remainder = job.rawBytes - LOG_HEAD_CAP;
    if (remainder > LOG_TAIL_CAP) appendFileSync(job.logPath, "\n… log middle truncated …\n");
    appendFileSync(job.logPath, job.rawTail.subarray(-Math.min(remainder, LOG_TAIL_CAP)));
  }
  job.onFinish?.();
  for (const notify of job.waiters.splice(0)) notify();
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly logDir: string;
  private sequence = 0;

  constructor(logDir: string) {
    this.logDir = logDir;
    mkdirSync(logDir, { recursive: true });
  }

  start(command: string, options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; file?: string; args?: string[]; onFinish?: () => void } = { cwd: process.cwd() }): JobStatus {
    const live = [...this.jobs.values()].filter((job) => job.endedAt === undefined);
    if (live.length >= MAX_LIVE_JOBS) {
      throw new Error(`too many live jobs (${live.length}); wait for or kill one first: ${live.map((job) => job.id).join(", ")}`);
    }

    const id = `job-${++this.sequence}`;
    const logPath = path.join(this.logDir, `${id}.log`);
    const child = spawn(options.file ?? "/bin/sh", options.args ?? ["-c", command], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
    });
    const job: Job = {
      id,
      command,
      child,
      startedAt: Date.now(),
      exitCode: null,
      timedOut: false,
      bytes: 0,
      lines: 0,
      head: [],
      headBytes: 0,
      tail: [],
      tailBytes: 0,
      streams: {
        stdout: { pending: "", decoder: new StringDecoder("utf8") },
        stderr: { pending: "", decoder: new StringDecoder("utf8") },
      },
      outputLoss: false,
      logBytes: 0,
      rawBytes: 0,
      rawTail: Buffer.alloc(0),
      onFinish: options.onFinish,
      logPath,
      waiters: [],
    };
    this.jobs.set(id, job);

    child.stdout.on("data", (chunk: Buffer) => ingest(job, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => ingest(job, chunk, "stderr"));
    child.on("error", () => {
      job.exitCode = 127;
      finish(job);
    });
    child.on("close", (code, signal) => {
      job.exitCode = job.timedOut ? 124 : (code ?? (signal ? 137 : 1));
      finish(job);
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      job.timer = setTimeout(() => {
        job.timedOut = true;
        this.kill(id);
      }, timeoutMs);
      job.timer.unref?.();
    }
    return this.status(job);
  }

  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}${this.jobs.size ? `; known: ${[...this.jobs.keys()].join(", ")}` : ""}`);
    return job;
  }

  private status(job: Job): JobStatus {
    return {
      id: job.id,
      command: job.command,
      pid: job.child.pid,
      running: job.endedAt === undefined,
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      lines: job.lines,
      bytes: job.bytes,
      logPath: this.logPath(job.id),
    };
  }

  private logPath(id: string): string {
    return path.join(this.logDir, `${id}.log`);
  }

  statusOf(id: string): JobStatus {
    return this.status(this.get(id));
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map((job) => this.status(job));
  }

  /** Last `n` lines (default 40): where the interesting part of a build log is. */
  tail(id: string, n = 40): { id: string; running: boolean; lines: string; exitCode: number | null } {
    const job = this.get(id);
    const take = Math.max(1, Math.min(n, 2000));
    return {
      id,
      running: job.endedAt === undefined,
      exitCode: job.exitCode,
      lines: job.tail.slice(-take).join("\n"),
    };
  }

  head(id: string, n = 40): string {
    const job = this.get(id);
    return job.head.slice(0, Math.max(1, Math.min(n, 2000))).join("\n");
  }

  /** Regex over the whole log, with optional context lines: the model asks for what it wants, exactly. */
  async grep(id: string, pattern: string, options: { context?: number; max?: number } = {}, signal?: AbortSignal): Promise<{ id: string; matches: string[]; truncated: boolean }> {
    const job = this.get(id);
    if (signal?.aborted) throw new Error("program cancelled before log search");
    if (typeof pattern !== "string" || pattern.length > 4096) throw new Error("log search pattern must be at most 4096 characters");
    const context = Math.max(0, Math.min(options.context ?? 0, 5));
    const max = Math.max(1, Math.min(options.max ?? 100, 500));
    const file = this.logPath(id);
    const text = (existsSync(file) ? readFileSync(file, "utf8") : "").replace(ANSI, "");
    const incomplete = job.endedAt === undefined || job.rawBytes > LOG_HEAD_CAP + LOG_TAIL_CAP;
    return new Promise((resolve, reject) => {
      const worker = new Worker(GREP_WORKER, { eval: true, workerData: { text, pattern, context, max }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
      let settled = false;
      const finish = (error?: Error, result?: { matches: string[]; truncated: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        if (error) reject(error);
        else resolve({ id, matches: result!.matches, truncated: result!.truncated || incomplete });
      };
      const onAbort = () => finish(new Error("program cancelled during log search"));
      const timer = setTimeout(() => finish(new Error("log search exceeded 1500ms; use a simpler pattern")), 1500);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (result: { matches: string[]; truncated: boolean; error?: string }) => {
        if (result.error) finish(new Error(`invalid log search: ${result.error}`));
        else finish(undefined, result);
      });
      worker.on("error", error => finish(error));
      worker.on("exit", code => { if (!settled) finish(new Error(`log search worker exited (${code})`)); });
    });
  }

  /** Resolves when the job ends or the wait expires; never holds longer than asked. */
  async wait(id: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<JobStatus> {
    const job = this.get(id);
    if (signal?.aborted) throw new Error("program cancelled while waiting for job");
    if (job.endedAt !== undefined) return this.status(job);
    const bounded = Math.max(1, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        const index = job.waiters.indexOf(done);
        if (index !== -1) job.waiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(new Error("program cancelled while waiting for job")); };
      const timer = setTimeout(done, bounded);
      timer.unref?.();
      job.waiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return this.status(job);
  }

  /** SIGTERM to the whole process group, SIGKILL after a grace period. */
  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): JobStatus {
    const job = this.get(id);
    if (job.endedAt !== undefined) return this.status(job);
    const pid = job.child.pid;
    const send = (sig: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(process.platform === "win32" ? pid : -pid, sig);
      } catch {
        try {
          job.child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    send(signal);
    if (signal !== "SIGKILL") {
      const escalate = setTimeout(() => {
        if (job.endedAt === undefined) send("SIGKILL");
      }, TERM_GRACE_MS);
      escalate.unref?.();
      job.waiters.push(() => clearTimeout(escalate));
    }
    return this.status(job);
  }

  /** Blocking read of a finished job: head and tail joined, never the whole log. */
  output(id: string, options: { maxBytes?: number } = {}): { id: string; running: boolean; exitCode: number | null; text: string; truncated: boolean } {
    const job = this.get(id);
    const requested = options.maxBytes ?? 16 * 1024;
    const maxBytes = Number.isFinite(requested) ? Math.max(0, Math.min(Math.floor(requested), 1024 * 1024)) : 16 * 1024;
    const tailStart = job.lines - job.tail.length;
    const gap = Math.max(0, tailStart - job.head.length);
    const whole = tailStart === 0
      ? job.tail.join("\n")
      : gap > 0
        ? `${job.head.join("\n")}\n… ${gap} lines elided …\n${job.tail.join("\n")}`
        : [...job.head, ...job.tail.slice(job.head.length - tailStart)].join("\n");
    const bytes = Buffer.from(whole, "utf8");
    const truncated = bytes.length > maxBytes || gap > 0 || job.outputLoss;
    let text = whole;
    if (bytes.length > maxBytes) {
      const marker = "\n… output truncated …\n";
      const available = maxBytes - Buffer.byteLength(marker);
      if (available <= 0) text = "";
      else {
        let headEnd = Math.floor(available / 2);
        let tailStart = bytes.length - (available - headEnd);
        while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
        while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
        text = bytes.subarray(0, headEnd).toString("utf8") + marker + bytes.subarray(tailStart).toString("utf8");
      }
    }
    return {
      id,
      running: job.endedAt === undefined,
      exitCode: job.exitCode,
      text,
      truncated,
    };
  }

  /** Tool shutdown: no orphaned process groups. */
  async close(timeoutMs = KILL_WAIT_MS): Promise<void> {
    const live = [...this.jobs.values()].filter((job) => job.endedAt === undefined);
    await Promise.all(
      live.map(async (job) => {
        this.kill(job.id, "SIGKILL");
        await this.wait(job.id, timeoutMs);
        finish(job);
      }),
    );
    rmSync(this.logDir, { recursive: true, force: true });
  }

  /** Test/CLI convenience: does this log exist from an earlier process? */
  hasLog(id: string): boolean {
    return existsSync(this.logPath(id));
  }
}
