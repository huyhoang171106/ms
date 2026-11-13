#!/usr/bin/env python3
"""Minimal zero-dependency Protocol v1 NDJSON client for `ms` (K1.5 smoke example)."""

import argparse
import json
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple


class MsClient:
    def __init__(self, ms_bin: str, root: str, allow_write: bool = False, state_dir: Optional[str] = None) -> None:
        cmd = [ms_bin, "--root", root]
        if allow_write:
            if not state_dir:
                raise ValueError("state_dir is required when allow_write=True")
            cmd.extend(["--allow-write", "--state-dir", state_dir])
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._next_id = 1

    def _alloc_id(self) -> str:
        req_id = f"py-{self._next_id}"
        self._next_id += 1
        return req_id

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        assert self._proc.stdin is not None and self._proc.stdout is not None
        req_id = self._alloc_id()
        payload = {"id": req_id, "method": method, "params": params or {}}
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()

        events: List[Dict[str, Any]] = []
        while True:
            line = self._proc.stdout.readline()
            if not line:
                stderr_tail = self._proc.stderr.read() if self._proc.stderr else ""
                raise RuntimeError(f"ms exited unexpectedly while waiting for {req_id}: {stderr_tail}")
            ev = json.loads(line)
            if ev.get("type") == "protocol_error":
                raise RuntimeError(f"protocol_error: {ev}")
            if ev.get("requestId") != req_id:
                continue
            if ev.get("type") == "completed":
                return events, ev
            events.append(ev)

    def close(self) -> int:
        if self._proc.stdin:
            self._proc.stdin.close()
        return self._proc.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a K1.5 smoke session against `ms`")
    parser.add_argument("--ms-bin", default="./target/release/ms", help="Path to ms binary")
    parser.add_argument("--root", default=".", help="Workspace root directory")
    args = parser.parse_args()

    client = MsClient(args.ms_bin, args.root)
    try:
        _, init_ev = client.request("initialize", {"clientName": "python-example", "clientVersion": "0.1.0"})
        print("initialize:", json.dumps(init_ev["result"], indent=2))

        _, open_ev = client.request("session.open", {"capabilities": {"allowWrite": False}})
        session_id = open_ev["result"]["sessionId"]
        print("opened session:", session_id)

        list_events, list_done = client.request(
            "call",
            {"sessionId": session_id, "operation": {"kind": "list", "maxEntries": 10}},
        )
        print("list status:", list_done["status"], "batches:", len(list_events))

        _, close_ev = client.request("session.close", {"sessionId": session_id})
        print("closed session:", close_ev["result"])
    finally:
        rc = client.close()
        print("ms exited with code:", rc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
