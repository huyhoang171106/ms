#!/usr/bin/env python3
"""Comprehensive stdio JSON-RPC 2.0 E2E test suite for `ms mcp`."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BIN = ROOT / "target" / "release" / "ms"


class McpClient:
    def __init__(self, bin_path: Path, ws_root: Path, state_dir: Path, log_dir: Path) -> None:
        env = os.environ.copy()
        env["MS_LOG_DIR"] = str(log_dir)
        self.proc = subprocess.Popen(
            [
                str(bin_path),
                "mcp",
                "--allow-write",
                "--root",
                str(ws_root),
                "--state-dir",
                str(state_dir),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        self._next_id = 1

    def __enter__(self) -> McpClient:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def send_raw(self, line: str) -> dict:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()
        resp_line = self.proc.stdout.readline()
        if not resp_line:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"MCP server closed stdout unexpectedly; stderr={stderr}")
        return json.loads(resp_line)

    def notify(self, method: str, params: dict | None = None) -> None:
        assert self.proc.stdin is not None
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None) -> dict:
        req_id = self._next_id
        self._next_id += 1
        msg: dict = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        resp = self.send_raw(json.dumps(msg))
        assert resp.get("id") == req_id, f"ID mismatch: expected {req_id}, got {resp}"
        return resp

    def call_tool(self, name: str, arguments: dict) -> tuple[str, bool]:
        resp = self.request("tools/call", {"name": name, "arguments": arguments})
        assert "result" in resp, f"Expected result for {name}, got: {resp}"
        res = resp["result"]
        content = res["content"]
        assert isinstance(content, list) and len(content) >= 1
        assert content[0]["type"] == "text"
        return content[0]["text"], bool(res.get("isError", False))


def run_mcp_e2e() -> None:
    if not DEFAULT_BIN.exists():
        raise RuntimeError(f"release binary not found at {DEFAULT_BIN}")

    with tempfile.TemporaryDirectory(prefix="ms-mcp-e2e-") as tmp:
        tmp_path = Path(tmp)
        ws = tmp_path / "ws"
        state = tmp_path / "state"
        log_dir = tmp_path / "logs"
        ws.mkdir()
        state.mkdir()
        log_dir.mkdir()

        # Populate workspace
        (ws / "src").mkdir()
        (ws / "tests").mkdir()
        (ws / ".env").write_text("SECRET_KEY=super_secret_123\n", encoding="utf-8")
        (ws / "src" / "app.py").write_text(
            "def add(a: int, b: int) -> int:\n"
            "    return a + b\n\n"
            "def greet(name: str) -> str:\n"
            "    return f'hello {name}'\n",
            encoding="utf-8",
        )
        (ws / "src" / "extra.txt").write_text("alpha\nbeta\n", encoding="utf-8")
        (ws / "tests" / "test_app.py").write_text(
            "from src.app import add\n\n"
            "def test_add():\n"
            "    assert add(1, 2) == 3\n",
            encoding="utf-8",
        )

        with McpClient(DEFAULT_BIN, ws, state, log_dir) as mcp:
            # 1. initialize, notifications/initialized, ping
            init_resp = mcp.request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "mcp-e2e", "version": "1.0"},
                },
            )
            assert init_resp["result"]["protocolVersion"] == "2024-11-05"
            assert init_resp["result"]["serverInfo"]["name"] == "ms"
            mcp.notify("notifications/initialized")
            ping_resp = mcp.request("ping")
            assert ping_resp["result"] == {}

            # 2. tools/list: verify all 11 tools and valid JSON schemas
            tools_resp = mcp.request("tools/list")
            tools = tools_resp["result"]["tools"]
            expected_tools = {
                "ms_exec",
                "ms_log",
                "ms_read",
                "ms_search",
                "ms_edit",
                "ms_write",
                "ms_delete",
                "ms_patch_batch",
                "ms_undo",
                "ms_outline",
                "ms_context",
            }
            by_name = {t["name"]: t for t in tools}
            assert expected_tools <= set(by_name.keys()), f"Missing tools: {expected_tools - set(by_name.keys())}"
            for name in expected_tools:
                schema = by_name[name]["inputSchema"]
                assert schema["type"] == "object"
                assert "properties" in schema

            # 3. ms_read (hashline)
            read_txt, is_err = mcp.call_tool("ms_read", {"path": "src/app.py", "startLine": 1, "lineCount": 50})
            assert not is_err, read_txt
            assert read_txt.startswith("rev:")
            rev_match = re.match(r"^rev:([0-9a-f]{64})", read_txt)
            assert rev_match, f"Missing 64-char rev in: {read_txt}"
            app_rev = rev_match.group(1)
            line2 = [l for l in read_txt.splitlines() if l.startswith("2:")][0]
            tag2 = line2.split(":")[1].split("|")[0]

            # 4. ms_edit (self-healing conflict on wrong tag, then valid line+tag edit)
            conflict_txt, is_err = mcp.call_tool(
                "ms_edit",
                {
                    "path": "src/app.py",
                    "edits": [{"startLine": 2, "endLine": 2, "startTag": "zzzz", "replacement": "    return a - b"}],
                },
            )
            assert is_err
            assert "E_CONFLICT" in conflict_txt
            assert "2:" in conflict_txt  # self-healing hint

            edit_txt, is_err = mcp.call_tool(
                "ms_edit",
                {
                    "path": "src/app.py",
                    "expectedRevision": app_rev,
                    "edits": [{"startLine": 2, "endLine": 2, "startTag": tag2, "replacement": "    return a + b + 0"}],
                },
            )
            assert not is_err, edit_txt
            assert "ok path:src/app.py" in edit_txt

            # 5. ms_write -> ms_delete -> ms_undo
            write_txt, is_err = mcp.call_tool(
                "ms_write",
                {"path": "src/new_mod.py", "content": "X = 42\n"},
            )
            assert not is_err, write_txt
            assert (ws / "src" / "new_mod.py").exists()

            del_txt, is_err = mcp.call_tool("ms_delete", {"path": "src/new_mod.py"})
            assert not is_err, del_txt
            assert not (ws / "src" / "new_mod.py").exists()

            undo_txt, is_err = mcp.call_tool("ms_undo", {})
            assert not is_err, undo_txt
            assert (ws / "src" / "new_mod.py").exists()
            assert (ws / "src" / "new_mod.py").read_text(encoding="utf-8") == "X = 42\n"

            # 6. ms_search, ms_outline, ms_context
            search_txt, is_err = mcp.call_tool("ms_search", {"query": "greet", "path": "src"})
            assert not is_err, search_txt
            assert "src/app.py" in search_txt
            assert "def greet" in search_txt

            outline_txt, is_err = mcp.call_tool("ms_outline", {})
            assert not is_err, outline_txt
            assert "src/app.py" in outline_txt
            assert "def add" in outline_txt

            ctx_txt, is_err = mcp.call_tool("ms_context", {"path": "src/app.py", "line": 1})
            assert not is_err, ctx_txt
            assert "rev:" in ctx_txt
            assert "def add" in ctx_txt

            # 7. ms_exec + ms_log
            exec_txt, is_err = mcp.call_tool(
                "ms_exec",
                {"command": "python3 -c \"for i in range(25): print(f'mcp-log-line-{i}')\""},
            )
            assert not is_err, exec_txt
            assert "[OK | exit:0" in exec_txt
            m_log = re.search(r"log:(log-[^\s|\]]+)", exec_txt)
            assert m_log, f"Missing log_id in ms_exec output: {exec_txt}"
            log_id = m_log.group(1)

            log_txt, is_err = mcp.call_tool("ms_log", {"id": log_id, "tail": 10, "grep": "mcp-log-line-22"})
            assert not is_err, log_txt
            assert "mcp-log-line-22" in log_txt

            # 8. ms_patch_batch (success + mid-batch rollback)
            extra_read, is_err = mcp.call_tool("ms_read", {"path": "src/extra.txt"})
            assert not is_err
            extra_rev = re.match(r"^rev:([0-9a-f]{64})", extra_read).group(1)

            # Mid-batch failure: item 0 mutates src/extra.txt, item 1 writes src/batch_tmp.txt,
            # item 2 tries to patch src/extra.txt with stale extra_rev -> triggers automatic rollback!
            batch_fail_txt, is_err = mcp.call_tool(
                "ms_patch_batch",
                {
                    "operations": [
                        {
                            "kind": "patch",
                            "path": "src/extra.txt",
                            "expectedRevision": extra_rev,
                            "edits": [{"startByte": 0, "endByte": 5, "replacement": "ALPHA"}],
                        },
                        {
                            "kind": "write_file",
                            "path": "src/batch_tmp.txt",
                            "content": "temp\n",
                        },
                        {
                            "kind": "patch",
                            "path": "src/extra.txt",
                            "expectedRevision": extra_rev,
                            "edits": [{"startByte": 0, "endByte": 5, "replacement": "SECOND"}],
                        },
                    ]
                },
            )
            assert is_err, f"Expected mid-batch rollback error, got: {batch_fail_txt}"
            assert "E_CONFLICT" in batch_fail_txt
            assert (ws / "src" / "extra.txt").read_text(encoding="utf-8") == "alpha\nbeta\n"
            assert not (ws / "src" / "batch_tmp.txt").exists()

            # Successful ms_patch_batch
            batch_ok_txt, is_err = mcp.call_tool(
                "ms_patch_batch",
                {
                    "operations": [
                        {
                            "kind": "patch",
                            "path": "src/extra.txt",
                            "expectedRevision": extra_rev,
                            "edits": [{"startByte": 0, "endByte": 5, "replacement": "ALPHA"}],
                        },
                        {
                            "kind": "write_file",
                            "path": "src/batch_ok.txt",
                            "content": "batch ok\n",
                        },
                    ]
                },
            )
            assert not is_err, batch_ok_txt
            assert (ws / "src" / "extra.txt").read_text(encoding="utf-8") == "ALPHA\nbeta\n"
            assert (ws / "src" / "batch_ok.txt").read_text(encoding="utf-8") == "batch ok\n"

            # 9. Error cases:
            # 9a. Malformed JSON
            bad_json_resp = mcp.send_raw("{not valid json")
            assert bad_json_resp["error"]["code"] == -32700

            # 9b. Unknown tool
            unk_txt, is_err = mcp.call_tool("ms_nonexistent_tool", {})
            assert is_err
            assert "unknown tool" in unk_txt

            # 9c. Policy-denied secret & traversal path
            sec_txt, is_err = mcp.call_tool("ms_read", {"path": ".env"})
            assert is_err
            assert "E_POLICY_DENIED" in sec_txt

            trav_txt, is_err = mcp.call_tool("ms_read", {"path": "../../etc/passwd"})
            assert is_err
            assert "E_INVALID_REQUEST" in trav_txt or "E_POLICY_DENIED" in trav_txt

            # 9d. Stale expectedRevision conflict on ms_edit
            stale_txt, is_err = mcp.call_tool(
                "ms_edit",
                {
                    "path": "src/app.py",
                    "expectedRevision": "0" * 64,
                    "edits": [{"oldText": "greet", "newText": "welcome"}],
                },
            )
            assert is_err
            assert "E_CONFLICT" in stale_txt


def main() -> int:
    started = time.perf_counter()
    try:
        run_mcp_e2e()
    except Exception as exc:
        print(f"[FAIL] test_mcp_e2e: {exc}", file=sys.stderr)
        return 1
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    print(f"[PASS] test_mcp_e2e ({elapsed_ms:.1f} ms)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
