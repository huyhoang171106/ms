"""Persistent CPython REPL for the C_py arm: one JSON request per stdin line, one JSON reply per stdout line."""
import ast
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import traceback

LIMIT = 16_000
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
    try:
        r = subprocess.run(cmd, shell=True, executable=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, timeout=timeout)
        return Shell(r.returncode, r.stdout.decode(errors="replace"))
    except subprocess.TimeoutExpired as e:
        return Shell(124, (e.stdout or b"").decode(errors="replace") + f"\n[timed out after {timeout}s]")


def clip(text):
    return text if len(text) <= LIMIT else f"{text[:LIMIT // 2]}\n… {len(text) - LIMIT} chars cut …\n{text[-LIMIT // 2:]}"


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
    return clip(text) or "(no output)"


def main():
    ns = {"__name__": "__main__", "bash": bash}
    for line in _in:
        reply = run(json.loads(line)["code"], ns)
        _out.write(json.dumps({"output": reply}) + "\n")
        _out.flush()


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        ns = {"bash": bash}
        assert run("x = 2\nx + 1", ns) == "3\n"
        assert run("x", ns) == "2\n", "state persists across cells"
        assert run("bash('echo hi; exit 3').code", ns) == "3\n"
        assert "ZeroDivisionError" in run("1/0", ns)
        assert "SystemExit" in run("raise SystemExit(1)", ns)
        assert run("import os; os.system('echo raw'); 0", ns) == "raw\n0\n", "fd-level output is captured"
        assert run("print(1)", ns) == "1\n"
        _out.write("ok\n")
    else:
        main()
