/**
 * Program runner for the single `ms` Axiom tool.
 *
 * Axiom gives the model one tool. One call is one program: reads, searches, edits, shell commands and
 * undo compose in the program, and only the value the program `return`s enters the conversation.
 */

import vm from "node:vm";

export type HostFn = (...args: any[]) => Promise<unknown>;

export interface KernelLimits {
  /** Host calls allowed per program. */
  maxCalls?: number;
  /** Wall-clock budget for the whole program; in-flight `ms` calls are cancelled when it expires. */
  timeoutMs?: number;
  /** Bytes of rendered result that may reach the conversation. */
  maxResultBytes?: number;
}

export interface KernelResult {
  ok: boolean;
  output: string;
  calls: number;
  durationMs: number;
  logs: string[];
}

export const DEFAULT_LIMITS = { maxCalls: 256, timeoutMs: 180_000, maxResultBytes: 24 * 1024 } as const;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

function cap(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let out = text;
  while (byteLength(out) > max) out = out.slice(0, Math.max(0, out.length - 4096));
  return `${out}\n… truncated: ${byteLength(text)} bytes / ${text.length} chars total`;
}

/** The conversation sees only this string; a program that returns nothing says so cheaply. */
export function render(value: unknown, max: number = DEFAULT_LIMITS.maxResultBytes): string {
  if (value === undefined) return "ok (no value returned)";
  if (typeof value === "string") return cap(value, max);
  try {
    const compact = JSON.stringify(value) ?? String(value);
    const formatted = byteLength(compact) <= 2048 ? (JSON.stringify(value, null, 1) ?? compact) : compact;
    return cap(formatted, max);
  } catch {
    return cap(String(value), max);
  }
}

/**
 * Runs `code` as the body of an async function whose only globals are `ms` (the capability table) and
 * `console` (collected, not printed). `makeApi` receives the program's abort signal so queued `ms`
 * calls die when the program times out.
 */
export async function runProgram(
  code: string,
  makeApi: (signal: AbortSignal) => Record<string, HostFn>,
  limits: KernelLimits = {},
  inputs: Record<string, string> = {},
): Promise<KernelResult> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const started = Date.now();
  const logs: string[] = [];
  const abort = new AbortController();
  let calls = 0;

  const log = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === "string" ? arg : render(arg, 4096))).join(" "));
  };

  const frozenInputs = Object.freeze({ ...inputs });
  const guarded: Record<string, unknown> = { inputs: frozenInputs };
  for (const [name, fn] of Object.entries(makeApi(abort.signal))) {
    guarded[name] = (...args: unknown[]) => {
      if (++calls > lim.maxCalls) {
        return Promise.reject(new Error(`host call budget exhausted (${lim.maxCalls} per program)`));
      }
      const p = Promise.resolve(fn(...args));
      // Prevent un-awaited calls (forgotten `await` or early throw) from crashing the host via UnhandledRejection on abort.
      p.catch(() => {});
      return p;
    };
  }

  const sandbox = {
    ms: Object.freeze(guarded),
    inputs: frozenInputs,
    console: Object.freeze({ log, info: log, warn: log, error: log, debug: log }),
  };
  // ponytail: node:vm is a correctness boundary, not a security boundary. The real limits are the
  // capability table (no require/process/fs) plus ms's own openat2-rooted, journaled workspace. Upgrade
  // path: run programs in a worker or child process under an OS sandbox.
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, name: "ms" });
  const source = `(async () => {\n${code}\n})()`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = vm.runInContext(source, context, { timeout: lim.timeoutMs, filename: "ms-program.js" }) as Promise<unknown>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`program exceeded ${lim.timeoutMs}ms`)), lim.timeoutMs);
      timer.unref?.();
    });
    const value = await Promise.race([pending, deadline]);
    return { ok: true, output: render(value, lim.maxResultBytes), calls, durationMs: Date.now() - started, logs };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, output: message, calls, durationMs: Date.now() - started, logs };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
