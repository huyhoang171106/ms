/** Isolated JavaScript runner for Axiom's single ms tool. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import readline from "node:readline";

export type HostFn = (...args: any[]) => Promise<unknown>;
export interface KernelLimits { maxCalls?: number; timeoutMs?: number; maxResultBytes?: number }
export interface KernelResult { ok: boolean; output: string; calls: number; durationMs: number; logs: string[] }
export const DEFAULT_LIMITS = { maxCalls: 256, timeoutMs: 180_000, maxResultBytes: 24 * 1024 } as const;

/** Limit UTF-8 output without splitting a code point. */
export function cap(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const marker = "\n… truncated";
  if (max <= Buffer.byteLength(marker)) return "";
  let end = max - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + marker;
}
export function render(value: unknown, max: number = DEFAULT_LIMITS.maxResultBytes): string {
  if (value === undefined) return "ok (no value returned)";
  if (typeof value === "string") return cap(value, max);
  try { return cap(JSON.stringify(value) ?? String(value), max); }
  catch { return cap(String(value), max); }
}

// The guest can access its own Node runtime, but has no host filesystem, environment or network.
const GUEST = String.raw`
const readline = require('node:readline');
const pending = new Map(); let next = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let started = false;
rl.on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!started) {
    started = true;
    const api = {inputs: Object.freeze(msg.inputs)};
    for (const name of msg.names) api[name] = (...args) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, {resolve, reject}); send({type:'call', id, name, args});
    });
    const log = (...args) => send({type:'log', text: args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')});
    const console = Object.freeze({log, info:log, warn:log, error:log, debug:log});
    try {
      const fn = new (Object.getPrototypeOf(async function(){}).constructor)('ms', 'inputs', 'console', msg.code);
      const value = await fn(Object.freeze(api), api.inputs, console);
      send({type:'result', ok:true, value: value === undefined ? 'ok (no value returned)' : value});
    } catch (e) { send({type:'result', ok:false, value: e instanceof Error ? e.name + ': ' + e.message + (e.hint ? '\n' + e.hint : '') : String(e)}); }
    return;
  }
  const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.value); else {
    const err = new Error(msg.error.message);
    if (msg.error.name) err.name = msg.error.name;
    if (msg.error.code) err.code = msg.error.code;
    if (msg.error.hint) err.hint = msg.error.hint;
    p.reject(err);
  }
});
`;

export async function runProgram(code: string, makeApi: (signal: AbortSignal) => Record<string, HostFn>, limits: KernelLimits = {}, inputs: Record<string, string> = {}, sandbox = true): Promise<KernelResult> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const started = Date.now();
  const abort = new AbortController();
  const api = makeApi(abort.signal);
  let calls = 0;
  const logs: string[] = [];
  let logBytes = 0;
  const active = new Set<Promise<void>>();
  const result = (ok: boolean, output: string): KernelResult => ({ ok, output: cap(output, lim.maxResultBytes), calls, durationMs: Date.now() - started, logs });
  const launch = (): { file: string; args: string[] } | string => {
    // Unsandboxed only when the caller's host is itself disposable (ms-tool `directExec`): the guest then runs on this runtime.
    if (!sandbox) return { file: process.execPath, args: ["-e", GUEST] };
    const which = spawnSync("which", ["node"], { encoding: "utf8" });
    if (which.status !== 0) return "sandbox unavailable: Node.js not found";
    let node: string;
    try { node = realpathSync(which.stdout.trim()); } catch { return "sandbox unavailable: Node.js not found"; }
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--ro-bind", node, "/node", "--proc", "/proc", "--dev", "/dev", "--size", "67108864", "--tmpfs", "/tmp"];
    for (const dir of ["/lib", "/lib64", "/usr/lib"]) if (existsSync(dir)) args.push("--ro-bind", dir, dir);
    args.push("--chdir", "/tmp", "--", "/node", "-e", GUEST);
    return { file: "bwrap", args };
  };
  const guest = launch();
  if (typeof guest === "string") return result(false, guest);
  const child = spawn(guest.file, guest.args, { stdio: ["pipe", "pipe", "pipe"], cwd: "/tmp", env: { PATH: process.env.PATH } });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString(), 2048); });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let frameBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    const last = chunk.lastIndexOf(10);
    frameBytes = last < 0 ? frameBytes + chunk.length : chunk.length - last - 1;
    if (frameBytes > 4 * 1024 * 1024) child.kill("SIGKILL");
  });
  let settled = false;
  let finish!: (value: KernelResult) => void;
  const done = new Promise<KernelResult>((resolve) => { finish = value => { if (!settled) { settled = true; resolve(value); } }; });
  const timer = setTimeout(() => { finish(result(false, `program exceeded ${lim.timeoutMs}ms`)); child.kill("SIGKILL"); }, lim.timeoutMs);
  const send = (msg: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + "\n"); };
  child.on("error", error => finish(result(false, `sandbox unavailable: ${error.message}`)));
  child.on("close", code => finish(result(false, `sandbox unavailable or guest exited (${code}): ${stderr}`)));
  rl.on("line", line => {
    if (settled) return;
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) { finish(result(false, "guest message exceeds limit")); child.kill("SIGKILL"); return; }
    let msg: any; try { msg = JSON.parse(line); } catch { finish(result(false, "invalid guest message")); child.kill("SIGKILL"); return; }
    if (msg.type === "log") {
      const text = cap(String(msg.text), Math.max(0, lim.maxResultBytes - logBytes));
      logBytes += Buffer.byteLength(text) + 1;
      if (text) logs.push(text);
    } else if (msg.type === "result") {
      finish(result(Boolean(msg.ok), typeof msg.value === "string" ? msg.value : render(msg.value, lim.maxResultBytes)));
    } else if (msg.type === "call" && Number.isSafeInteger(msg.id) && typeof msg.name === "string" && Array.isArray(msg.args)) {
      const fn = Object.hasOwn(api, msg.name) ? api[msg.name] : undefined;
      if (!fn) { send({ id: msg.id, ok: false, error: { message: "unknown capability" } }); return; }
      if (++calls > lim.maxCalls) { send({ id: msg.id, ok: false, error: { message: `host call budget exhausted (${lim.maxCalls} per program)` } }); return; }
      const work = Promise.resolve().then(() => fn(...msg.args)).then(
        value => send({ id: msg.id, ok: true, value }),
        error => send({ id: msg.id, ok: false, error: { message: String(error?.message ?? error), name: error?.name, code: error?.code, hint: error?.hint } }),
      ).catch(() => {});
      active.add(work); void work.finally(() => active.delete(work));
    }
  });
  send({ code, inputs, names: Object.keys(api) });
  const outcome = await done;
  clearTimeout(timer);
  abort.abort();
  child.kill("SIGKILL");
  await Promise.allSettled([...active]);
  return outcome;
}
