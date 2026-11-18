import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface Entry { path: string; kind: string }
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_CLOEXEC, O_NONBLOCK } = fs.constants;

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const file = fs.realpathSync(path.join(directory, name));
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

// Copy only Python modules needed by the installed pytest; never expose the user site directory.
export function stagePytest(snapshot: string, rootFd: number): void {
  const python = findExecutable("python3");
  if (!python) return;
  const script = `import importlib.util,json,site,sys
sys.path.append(site.getusersitepackages())
names = ('pytest', '_pytest', 'pluggy', 'iniconfig', 'packaging', 'pygments', 'py')
out = {}
for name in names:
 spec = importlib.util.find_spec(name)
 if spec and spec.submodule_search_locations:
  out[name] = list(spec.submodule_search_locations)[0]
 elif spec and spec.origin and spec.origin.endswith('.py'):
  out[name] = spec.origin
print(json.dumps(out))`;
  const found = spawnSync(python, ["-S", "-c", script], {
    cwd: "/", env: { PATH: process.env.PATH, HOME: os.homedir() }, encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024,
  });
  if (found.status !== 0) return;
  let modules: Record<string, string>;
  try { modules = JSON.parse(found.stdout); } catch { return; }
  const workspace = fs.realpathSync(`/proc/self/fd/${rootFd}`);
  const runtime = path.join(snapshot, "python");
  let bytesCopied = 0;
  let filesCopied = 0;
  const copyFile = (source: string, destination: string) => {
    const fd = fs.openSync(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) return;
      bytesCopied += stat.size;
      if (++filesCopied > 20_000 || stat.size > 8 * 1024 * 1024 || bytesCopied > 32 * 1024 * 1024) throw new Error("Python runtime copy limit exceeded");
      const buffer = Buffer.alloc(stat.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const n = fs.readSync(fd, buffer, used, buffer.length - used, used);
        if (!n) break;
        used += n;
      }
      const after = fs.fstatSync(fd);
      if (used !== stat.size || after.size !== stat.size || after.nlink !== 1) throw new Error("Python module changed during snapshot");
      fs.writeFileSync(destination, buffer.subarray(0, used), { mode: 0o600 });
    } finally { fs.closeSync(fd); }
  };
  const copyTree = (dirFd: number, destination: string) => {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(`/proc/self/fd/${dirFd}`, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith(".") || name === "__pycache__" || /^(?:secrets?(?:\.|$)|id_rsa|id_ed25519)/i.test(name) || /\.(?:pyc|pem|key|p12|pfx)$/i.test(name)) continue;
      const source = `/proc/self/fd/${dirFd}/${name}`;
      if (entry.isDirectory()) {
        const fd = fs.openSync(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        try { copyTree(fd, path.join(destination, name)); } finally { fs.closeSync(fd); }
      } else if (entry.isFile()) {
        if (!/\.(?:py|so|typed)$/.test(name)) continue;
        copyFile(source, path.join(destination, name));
      }
    }
  };
  for (const name of ["pytest", "_pytest", "pluggy", "iniconfig", "packaging", "pygments", "py"]) {
    if (typeof modules[name] !== "string") continue;
    const source = fs.realpathSync(modules[name]);
    if (source === workspace || source.startsWith(workspace + path.sep)) continue;
    if (source === "/usr" || source.startsWith("/usr/")) continue;
    if (fs.statSync(source).isFile()) {
      fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
      copyFile(source, path.join(runtime, `${name}.py`));
    } else {
      const fd = fs.openSync(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      try { copyTree(fd, path.join(runtime, name)); } finally { fs.closeSync(fd); }
    }
  }
  if (modules.pytest) {
    const bin = path.join(snapshot, "python-bin");
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "pytest"), '#!/bin/sh\nexec python3 -m pytest "$@"\n', { mode: 0o700 });
  }
}

/** Copy only paths already listed under the runtime's effective read policy. */
export function createSnapshot(rootFd: number, entries: Entry[], command: string | string[]): string {
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "ms-snapshot-"));
  const workspace = path.join(snapshot, "workspace");
  let total = 0;
  try {
    fs.mkdirSync(workspace, { mode: 0o700 });
    for (const entry of entries) {
      if (entry.kind !== "file" || /(^|\/)\.git(?:\/|$)/.test(entry.path)) continue;
      const parts = entry.path.split("/");
      if (parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid snapshot path");
      let dirFd = rootFd;
      const opened: number[] = [];
      try {
        for (const part of parts.slice(0, -1)) {
          dirFd = fs.openSync(`/proc/self/fd/${dirFd}/${part}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          opened.push(dirFd);
        }
        const fd = fs.openSync(`/proc/self/fd/${dirFd}/${parts.at(-1)}`, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
        opened.push(fd);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) continue;
        total += stat.size;
        if (stat.size > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("snapshot size limit exceeded");
        const target = path.join(workspace, ...parts);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const bytes = Buffer.alloc(stat.size + 1);
        let used = 0;
        while (used < bytes.length) {
          const n = fs.readSync(fd, bytes, used, bytes.length - used, used);
          if (!n) break;
          used += n;
        }
        const after = fs.fstatSync(fd);
        if (used !== stat.size || after.size !== stat.size || after.nlink !== 1) throw new Error(`file changed during snapshot: ${entry.path}`);
        fs.writeFileSync(target, bytes.subarray(0, used), { mode: stat.mode & 0o777 });
      } finally {
        for (const fd of opened.reverse()) fs.closeSync(fd);
      }
    }
    if ((Array.isArray(command) ? command.join(" ") : command).includes("pytest")) stagePytest(snapshot, rootFd);
    return snapshot;
  } catch (error) {
    fs.rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export function sandboxCommand(snapshot: string, command: string | string[]): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/opt/ms-bin:/usr/local/bin:/usr/bin:/bin", "--ro-bind", path.join(snapshot, "workspace"), "/source", "--size", "134217728", "--tmpfs", "/workspace", "--chdir", "/workspace", "--proc", "/proc", "--dev", "/dev", "--size", "67108864", "--tmpfs", "/tmp"];
  for (const dir of ["/usr", "/bin", "/lib", "/lib64"]) if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
  args.push("--dir", "/opt", "--dir", "/opt/ms-bin");
  for (const name of ["node", "bun"]) {
    const file = findExecutable(name);
    if (file) args.push("--ro-bind", file, `/opt/ms-bin/${name}`);
  }
  const python = path.join(snapshot, "python");
  if (fs.existsSync(python)) args.push("--ro-bind", python, "/opt/ms-python", "--setenv", "PYTHONPATH", "/opt/ms-python");
  const pytest = path.join(snapshot, "python-bin", "pytest");
  if (fs.existsSync(pytest)) args.push("--ro-bind", pytest, "/opt/ms-bin/pytest");
  args.push("--", "/bin/sh", "-c", 'cp -a /source/. /workspace/ && exec "$@"', "ms-sandbox", ...(Array.isArray(command) ? command : ["/bin/sh", "-c", command]));
  return args;
}
