"""Persistent CPython REPL for the C_py arm: one JSON request per stdin line, one JSON reply per stdout line."""
import ast
import contextlib
import io
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import traceback

LIMIT = 16_000
PREVIEW = "--preview" in sys.argv[1:]  # A/B flag: long outputs -> preview + out() paging instead of a 16k clip
# Protocol gets its own fd; fds 1/2 are captured per cell so os.system/subprocess output cannot corrupt it.
_out = os.fdopen(os.dup(1), "w")
_null = os.open(os.devnull, os.O_WRONLY)
# Requests also get a private fd; fd 0 becomes /dev/null so a child that reads stdin (`sed -n 1,5p` with no file) gets EOF
# instead of blocking on the protocol pipe until the 900s cell timeout (luna-lean26 fix-vuln lost its run that way).
_in = os.fdopen(os.dup(0), "r")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
sys.stdin = open(os.devnull)


class Shell(str):
    """bash() result: prints as '[exit N]\\n<output>'; `.code` and `.out` for programmatic use."""

    def __new__(cls, code, out):
        self = super().__new__(cls, f"[exit {code}]\n{out}")
        self.code, self.out = code, out
        return self

    def __repr__(self):
        return str(self)


def bash(cmd, timeout=600):
    shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
    # Own process group: on timeout kill the whole tree. subprocess.run kills only the shell, so a hung server or test
    # run it started kept running (and holding ports, files and CPU) for the rest of the episode.
    p = subprocess.Popen(cmd, shell=True, executable=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        out, _ = p.communicate(timeout=timeout)
        return Shell(p.returncode, out.decode(errors="replace"))
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, signal.SIGKILL)
        out, _ = p.communicate()
        return Shell(124, out.decode(errors="replace") + f"\n[timed out after {timeout}s]")


def clip(text):
    return text if len(text) <= LIMIT else f"{text[:LIMIT // 2]}\n… {len(text) - LIMIT} chars cut …\n{text[-LIMIT // 2:]}"


PREVIEW_OVER, PREVIEW_SIDE = 8_000, 3_000
_outputs = {}  # cell id -> full output, kept for out(); only with --preview
_FAIL = re.compile(r"^\[exit [1-9]\d*\]|Traceback \(most recent call last\)|^Error:")


def out(cell, start=1, stop=None):
    """Lines start..stop (1-based, inclusive) of an earlier cell's full output."""
    lines = _outputs[cell].splitlines()
    return "\n".join(lines[start - 1:stop])


def preview(text):
    """Immutable head+tail preview of a long output; the full text stays in the REPL (out(id, a, b)).
    Old history is never rewritten, so the backend prompt cache keeps hitting (rewrites -> cacheRead 0 on Codex)."""
    if len(text.encode()) <= PREVIEW_OVER:
        return text
    cell = len(_outputs) + 1
    _outputs[cell] = text
    lines = text.splitlines()
    head = tail = 0
    while head < len(lines) and sum(len(l) + 1 for l in lines[:head + 1]) <= PREVIEW_SIDE:
        head += 1
    while tail < len(lines) - head and sum(len(l) + 1 for l in lines[len(lines) - tail - 1:]) <= PREVIEW_SIDE:
        tail += 1
    head = max(head, 1)
    mid = lines[head:len(lines) - tail]
    if not mid:
        return clip(text)
    fails = [l for l in mid if _FAIL.search(l)][:5]
    note = f"… lines {head + 1}-{len(lines) - tail} of {len(lines)} omitted; out({cell}, {head + 1}, {len(lines) - tail}) prints them …"
    return "\n".join(lines[:head] + [note] + fails + lines[len(lines) - tail:])


def run(code, ns):
    with tempfile.TemporaryFile() as tmp:
        os.dup2(tmp.fileno(), 1)
        os.dup2(tmp.fileno(), 2)
        try:
            tree = ast.parse(code, "<cell>", "exec")
            last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, "<cell>", "exec"), ns)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), "<cell>", "eval"), ns)
                if value is not None:
                    print(repr(value))
        except BaseException:  # SystemExit/KeyboardInterrupt from model code must not kill the kernel.
            traceback.print_exc()
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(_null, 1)
            os.dup2(_null, 2)
        tmp.seek(0)
        text = tmp.read().decode(errors="replace")
    return (preview(text) if PREVIEW else clip(text)) or "(no output)"


def system_python():
    """The container's own python on PATH (not this bundled one), or None."""
    own = os.path.realpath(sys.base_prefix) + os.sep
    for name in ("python3", "python"):
        for d in os.environ.get("PATH", "").split(os.pathsep):
            p = os.path.join(d, name)
            if os.path.isfile(p) and os.access(p, os.X_OK) and not os.path.realpath(p).startswith(own):
                return p
    return None


def main():
    # `sys.executable -m pip install` must reach the interpreter the task's tests use: tb21 luna-high kv-store-grpc,
    # 7/7 runs that pip-installed via sys.executable landed grpcio in the bundled python and failed; 3/3 via `python` passed.
    # ponytail: REPL imports still resolve against the bundled python; multiprocessing 'spawn' would now start the system one.
    sys.executable = system_python() or sys.executable
    ns = {"__name__": "__main__", "bash": bash, "out": out}
    for line in _in:
        reply = run(json.loads(line)["code"], ns)
        _out.write(json.dumps({"output": reply}) + "\n")
        _out.flush()


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        PREVIEW = True
        big = run("print('\\n'.join(f'line {i}' for i in range(2000)) + '\\nTraceback (most recent call last)\\n' + 'z' * 10)", {"bash": bash})
        assert "out(1, " in big and "Traceback (most recent call last)" in big and len(big) < 7_000, big[:200]
        assert out(1, 1000, 1000) == "line 999", "omitted lines are retrievable"
        assert run("print('short')", {}) == "short\n"
        PREVIEW = False
        ns = {"bash": bash}
        assert run("x = 2\nx + 1", ns) == "3\n"
        assert run("x", ns) == "2\n", "state persists across cells"
        assert run("bash('echo hi; exit 3').code", ns) == "3\n"
        assert "ZeroDivisionError" in run("1/0", ns)
        assert "SystemExit" in run("raise SystemExit(1)", ns)
        assert run("import os; os.system('echo raw'); 0", ns) == "raw\n0\n", "fd-level output is captured"
        assert run("print(1)", ns) == "1\n"
        import time
        t = time.time()
        out = run("bash('sleep 31.5 & sleep 31.5; echo never', timeout=1)", ns)
        assert "[exit 124]" in out and "never" not in out and time.time() - t < 10
        time.sleep(0.2)
        assert "sleep 31.5" not in bash("ps -eo args").out, "timeout kills the whole process group"
        _out.write("ok\n")
    else:
        main()
