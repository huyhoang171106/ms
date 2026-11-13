#!/usr/bin/env python3
"""NDJSON stdio client helper for `ms` E2E and fault-injection tests."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


DEFAULT_BIN = Path("/home/hoang/ms/target/release/ms")


class MsProcess:
    """Manages a live `ms` subprocess over NDJSON stdio."""

    def __init__(
        self,
        root: Path,
        state_dir: Path | None = None,
        allow_write: bool = False,
        binary: Path = DEFAULT_BIN,
        extra_args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.root = root
        self.state_dir = state_dir
        self.allow_write = allow_write
        self.binary = binary

        cmd = [str(self.binary), "--root", str(self.root)]
        if self.state_dir is not None:
            cmd.extend(["--state-dir", str(self.state_dir)])
        if self.allow_write:
            cmd.append("--allow-write")
        if extra_args:
            cmd.extend(extra_args)

        proc_env = os.environ.copy()
        if env:
            proc_env.update(env)

        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=proc_env,
        )
        self._stderr_chunks: list[bytes] = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()
        self._req_counter = 0

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while True:
            chunk = self.proc.stderr.read(4096)
            if not chunk:
                break
            self._stderr_chunks.append(chunk)

    def stderr_text(self) -> str:
        return b"".join(self._stderr_chunks).decode("utf-8", errors="replace")

    def next_id(self, prefix: str = "r") -> str:
        self._req_counter += 1
        return f"{prefix}{self._req_counter}"

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send_json(self, obj: dict[str, Any]) -> None:
        line = (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_raw(line)

    def send_request(self, req_id: str, method: str, params: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"id": req_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.send_json(payload)

    def read_event(self, timeout: float = 10.0) -> dict[str, Any] | None:
        assert self.proc.stdout is not None
        import select

        if not self.proc.stdout.peek(1):
            fd = self.proc.stdout.fileno()
            ready, _, _ = select.select([fd], [], [], timeout)
            if not ready:
                raise TimeoutError(f"Timed out after {timeout}s waiting for event from ms")
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line.decode("utf-8"))

    def read_until_completed(
        self, req_id: str, timeout: float = 10.0
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        events: list[dict[str, Any]] = []
        deadline = time.monotonic() + timeout
        expected_seq = 1
        while True:
            remaining = max(0.05, deadline - time.monotonic())
            ev = self.read_event(timeout=remaining)
            if ev is None:
                raise EOFError(f"ms stdout closed before completed event for {req_id}")
            if ev.get("requestId") == req_id:
                assert ev.get("seq") == expected_seq, (
                    f"Expected seq {expected_seq} for {req_id}, got {ev.get('seq')} in {ev}"
                )
                expected_seq += 1
                events.append(ev)
                if ev.get("type") == "completed":
                    return events, ev
            else:
                events.append(ev)

    def call_sync(
        self, method: str, params: dict[str, Any] | None = None, req_id: str | None = None, timeout: float = 10.0
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        rid = req_id or self.next_id()
        self.send_request(rid, method, params)
        return self.read_until_completed(rid, timeout=timeout)

    def initialize(self) -> dict[str, Any]:
        _, comp = self.call_sync(
            "initialize",
            {"clientName": "ms-e2e", "clientVersion": "0.1.0", "protocolVersion": "1.0"},
        )
        assert comp["status"] == "ok", f"initialize failed: {comp}"
        return comp["result"]

    def open_session(self, allow_write: bool | None = None) -> str:
        params: dict[str, Any] = {}
        if allow_write is not None:
            params["capabilities"] = {"allowWrite": allow_write}
        _, comp = self.call_sync("session.open", params)
        assert comp["status"] == "ok", f"session.open failed: {comp}"
        return comp["result"]["sessionId"]

    def close_session(self, session_id: str) -> dict[str, Any]:
        _, comp = self.call_sync("session.close", {"sessionId": session_id})
        return comp

    def call_op(
        self,
        session_id: str,
        operation: dict[str, Any],
        operation_id: str | None = None,
        deadline_ms: int | None = None,
        timeout: float = 10.0,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        params: dict[str, Any] = {"sessionId": session_id, "operation": operation}
        if operation_id is not None:
            params["operationId"] = operation_id
        if deadline_ms is not None:
            params["deadlineMs"] = deadline_ms
        return self.call_sync("call", params, timeout=timeout)

    def kill(self) -> None:
        self.proc.kill()
        self.proc.wait(timeout=5)

    def close(self) -> int:
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        rc = self.proc.wait(timeout=5)
        self._stderr_thread.join(timeout=2)
        return rc

    def __enter__(self) -> "MsProcess":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.proc.poll() is None:
            try:
                self.close()
            except Exception:
                self.kill()
