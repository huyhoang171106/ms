"""Persistent CPython REPL for the C_py arm: one JSON request per stdin line, one JSON reply per stdout line."""
import ast
import contextlib
import io
import json
import os
import subprocess
import sys
import traceback

LIMIT = 16_000
_out = sys.stdout


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
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
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
    return clip(buf.getvalue()) or "(no output)"


def main():
    ns = {"__name__": "__main__", "bash": bash}
    for line in sys.stdin:
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
        print("ok")
    else:
        main()
