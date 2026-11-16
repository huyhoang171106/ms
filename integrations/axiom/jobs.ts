/**
 * Live shell jobs, after Unharnessed's `bash()`: start returns at once, the handle outlives the cell,
 * and the model reads the bytes it needs instead of accepting a distilled guess.
 *
 * The tool instance is the kernel here: a job started in one program is still there in the next one,
 * so `start` -> end the turn -> `tail` costs two calls instead of one blocked call plus a timeout.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Keep the boundaries of the stream without holding all of it; the full log stays on disk. */
const HEAD_CAP = 64 * 1024;
const TAIL_CAP = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const TERM_GRACE_MS = 500;
const KILL_WAIT_MS = 2_000;
const MAX_LIVE_JOBS = 16;

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
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
}

const ANSI = /\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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

function ingest(job: Job, chunk: Buffer): void {
  // Synchronous append: `grep` can run while the job is still writing, and a buffered stream would
  // hand back a log missing its newest lines. One write syscall per chunk is the cheaper trade.
  appendFileSync(job.logPath, chunk);
  const text = job.pending + chunk.toString("utf8").replace(ANSI, "");
  const parts = text.split("\n");
  job.pending = parts.pop() ?? "";
  for (const line of parts) pushLine(job, line);
}

function finish(job: Job): void {
  if (job.endedAt !== undefined) return;
  job.endedAt = Date.now();
  if (job.pending) {
    pushLine(job, job.pending);
    job.pending = "";
  }
  if (job.timer) clearTimeout(job.timer);
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

  start(command: string, options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }): JobStatus {
    const live = [...this.jobs.values()].filter((job) => job.endedAt === undefined);
    if (live.length >= MAX_LIVE_JOBS) {
      throw new Error(`too many live jobs (${live.length}); wait for or kill one first: ${live.map((job) => job.id).join(", ")}`);
    }

    const id = `job-${++this.sequence}`;
    const logPath = path.join(this.logDir, `${id}.log`);
    const child = spawn("/bin/sh", ["-c", command], {
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
      pending: "",
      logPath,
      waiters: [],
    };
    this.jobs.set(id, job);

    child.stdout.on("data", (chunk: Buffer) => ingest(job, chunk));
    child.stderr.on("data", (chunk: Buffer) => ingest(job, chunk));
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
  grep(id: string, pattern: string, options: { context?: number; max?: number } = {}): { id: string; matches: string[]; truncated: boolean } {
    const job = this.get(id);
    const regex = new RegExp(pattern);
    const context = Math.max(0, Math.min(options.context ?? 0, 5));
    const max = Math.max(1, Math.min(options.max ?? 100, 500));
    const path = this.logPath(id);
    const lines = (existsSync(path) ? readFileSync(path, "utf8") : "").replace(ANSI, "").split("\n");
    const matches: string[] = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        for (let j = from; j <= to; j++) matches.push(`${j + 1}: ${lines[j]}`);
        i = to;
        if (matches.length >= max) {
          truncated = true;
          break;
        }
      }
    }
    void job;
    return { id, matches: matches.slice(0, max), truncated };
  }

  /** Resolves when the job ends or the wait expires; never holds longer than asked. */
  async wait(id: string, timeoutMs = 120_000): Promise<JobStatus> {
    const job = this.get(id);
    if (job.endedAt !== undefined) return this.status(job);
    const bounded = Math.max(1, timeoutMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, bounded);
      timer.unref?.();
      job.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
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
    const maxBytes = options.maxBytes ?? 16 * 1024;
    const head = job.head.join("\n");
    const tail = job.tail.join("\n");
    const whole = job.lines <= job.tail.length ? tail : `${head}\n… ${job.lines - job.tail.length} lines elided …\n${tail}`;
    const truncated = Buffer.byteLength(whole, "utf8") > maxBytes;
    return {
      id,
      running: job.endedAt === undefined,
      exitCode: job.exitCode,
      text: truncated ? whole.slice(-maxBytes) : whole,
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
  }

  /** Test/CLI convenience: does this log exist from an earlier process? */
  hasLog(id: string): boolean {
    return existsSync(this.logPath(id));
  }
}
