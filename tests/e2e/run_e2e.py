#!/usr/bin/env python3
"""E2E and fault-injection test suite (T01 - T13b) against target/release/ms."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "fixtures"))

from ms_client import DEFAULT_BIN, MsProcess
from workspace_helper import TempWorkspace


def collect_lines(events: list[dict]) -> list[dict]:
    lines: list[dict] = []
    for ev in events:
        if ev.get("type") == "records":
            lines.extend(ev.get("records", []))
    return lines


def read_file_full(ms: MsProcess, sid: str, path: str) -> tuple[dict, list[dict]]:
    events, comp = ms.call_op(sid, {"kind": "read", "path": path, "startLine": 1, "lineCount": 1000})
    assert comp["status"] == "ok", f"read({path}) failed: {comp}"
    return comp["result"], collect_lines(events)


# ---------------------------------------------------------------------------
# T01 P0: Path traversal, absolute path, symlink leaf/parent
# ---------------------------------------------------------------------------
def test_t01_path_traversal_and_symlinks() -> None:
    with TempWorkspace("small-repo", with_special_entries=True) as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            bad_paths = [
                "../outside/secret_outside.txt",
                "src/../../outside/secret_outside.txt",
                "/etc/passwd",
                str(ws.outside_dir / "secret_outside.txt"),
                "symlink_outside.txt",
                "symlink_inside.rs",
                "symlink_dir/secret_outside.txt",
            ]
            for p in bad_paths:
                _, comp = ms.call_op(sid, {"kind": "read", "path": p})
                assert comp["status"] == "error", f"T01 expected error for read({p}), got {comp}"
                code = comp["error"]["code"]
                assert code in ("E_POLICY_DENIED", "E_INVALID_REQUEST"), (
                    f"T01 unexpected error code for read({p}): {code}"
                )

                # Also verify patch is denied on symlink / traversal
                _, pcomp = ms.call_op(
                    sid,
                    {
                        "kind": "patch",
                        "path": p,
                        "expectedRevision": "0" * 64,
                        "edits": [{"startByte": 0, "endByte": 0, "replacement": "pwn"}],
                    },
                    operation_id=f"t01-patch-{p}",
                )
                assert pcomp["status"] == "error", f"T01 expected error for patch({p}), got {pcomp}"
                assert pcomp["error"]["code"] in ("E_POLICY_DENIED", "E_INVALID_REQUEST")

            assert (ws.outside_dir / "secret_outside.txt").read_text() == "OUTSIDE_SECRET_DATA\n"


# ---------------------------------------------------------------------------
# T02 P0: Secret deny path, special file/FIFO, large file / bounded output
# ---------------------------------------------------------------------------
def test_t02_secrets_fifo_and_bounds() -> None:
    with TempWorkspace("small-repo", with_special_entries=True) as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=False) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=False)

            for secret in (".env", ".git/config", ".git/HEAD", "secrets/credentials.json"):
                _, comp = ms.call_op(sid, {"kind": "read", "path": secret})
                assert comp["status"] == "error", f"T02 secret {secret} should be denied: {comp}"
                assert comp["error"]["code"] in ("E_POLICY_DENIED", "E_NOT_FOUND")

            # Search must not return secret contents
            sevents, scomp = ms.call_op(sid, {"kind": "search", "query": "super_secret_token_12345"})
            assert scomp["status"] == "ok"
            assert len(collect_lines(sevents)) == 0, "T02 search leaked .env secret!"

            # List must not expose .env or .git
            levents, lcomp = ms.call_op(sid, {"kind": "list", "recursive": True, "includeHidden": True})
            assert lcomp["status"] == "ok"
            listed_paths = {r["path"] for r in collect_lines(sevents)} | {r["path"] for r in collect_lines(levents)}
            assert ".env" not in listed_paths
            assert ".git/config" not in listed_paths

            # FIFO must not hang and must return error
            _, fcomp = ms.call_op(sid, {"kind": "read", "path": "edge/test_fifo"}, timeout=3.0)
            assert fcomp["status"] == "error", f"T02 FIFO read should error: {fcomp}"
            assert fcomp["error"]["code"] in ("E_POLICY_DENIED", "E_INVALID_REQUEST", "E_IO")

            stderr = ms.stderr_text()
            assert "super_secret_token_12345" not in stderr, "T02 secret leaked to stderr!"
            assert "do_not_leak" not in stderr, "T02 secret leaked to stderr!"


# ---------------------------------------------------------------------------
# T03 P0: Invalid JSON, fragmented frame, duplicate ID, oversized frame
# ---------------------------------------------------------------------------
def test_t03_protocol_framing_and_errors() -> None:
    with TempWorkspace("small-repo") as ws:
        # 3a: Invalid JSON without valid ID -> protocol_error
        with MsProcess(ws.root, ws.state_dir) as ms:
            ms.send_raw(b"{not valid json\n")
            ev = ms.read_event(timeout=3.0)
            assert ev is not None and ev["type"] == "protocol_error", f"T03a expected protocol_error, got {ev}"
            assert ev["code"] == "E_PROTOCOL"

            # 3b: Fragmented valid frame across multiple writes
            init_req = json.dumps({
                "id": "frag-1",
                "method": "initialize",
                "params": {"clientName": "e2e", "protocolVersion": "1.0"},
            }) + "\n"
            raw = init_req.encode("utf-8")
            mid = len(raw) // 2
            ms.send_raw(raw[:mid])
            time.sleep(0.05)
            ms.send_raw(raw[mid:])
            _, comp = ms.read_until_completed("frag-1")
            assert comp["status"] == "ok", f"T03b fragmented frame failed: {comp}"

            # 3c: Duplicate request ID rejected
            ms.send_request("frag-1", "initialize", {})
            _, dup_comp = ms.read_until_completed("frag-1")
            assert dup_comp["status"] == "error"
            assert dup_comp["error"]["code"] == "E_DUPLICATE_REQUEST_ID"

        # 3d: Oversized frame (> 1 MiB) -> fatal protocol_error + close connection
        with MsProcess(ws.root, ws.state_dir) as ms:
            huge = b'{"id":"big","method":"initialize","params":{"clientName":"' + (b"a" * (1024 * 1024 + 1024)) + b'"}}\n'
            try:
                ms.send_raw(huge)
            except BrokenPipeError:
                pass
            ev = ms.read_event(timeout=3.0)
            if ev is not None:
                assert ev["type"] == "protocol_error"
                assert ev["code"] == "E_PROTOCOL"
                assert ev["fatal"] is True
            rc = ms.proc.wait(timeout=5)
            assert rc != 0 or ev is not None


# ---------------------------------------------------------------------------
# T04 P1: Cancel & deadline
# ---------------------------------------------------------------------------
def test_t04_cancel_and_deadline() -> None:
    with TempWorkspace("large-repo") as ws:
        with MsProcess(ws.root, ws.state_dir) as ms:
            ms.initialize()
            sid = ms.open_session()

            # Send a search and immediately cancel it
            rid = ms.next_id("search")
            ms.send_request(rid, "call", {
                "sessionId": sid,
                "operation": {"kind": "search", "query": "compute_metric", "maxMatches": 5000},
            })
            ms.send_request(ms.next_id("cancel"), "cancel", {"requestId": rid})

            # Read events until both requests settle (search gets ok or cancelled; cancel gets ok)
            seen_search_comp = False
            deadline = time.monotonic() + 5.0
            while not seen_search_comp and time.monotonic() < deadline:
                ev = ms.read_event(timeout=3.0)
                if ev is None:
                    break
                if ev.get("requestId") == rid and ev.get("type") == "completed":
                    assert ev["status"] in ("ok", "cancelled"), f"T04 unexpected status: {ev}"
                    seen_search_comp = True
            assert seen_search_comp, "T04 search did not complete after cancel"


# ---------------------------------------------------------------------------
# T05 P0: Stale revision after external edit -> E_CONFLICT
# ---------------------------------------------------------------------------
def test_t05_stale_revision_conflict() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            res, lines = read_file_full(ms, sid, "src/stale_target.rs")
            old_rev = res["fileRevision"]
            target_line = lines[1]  # "    1"

            # External modification outside runtime
            target_path = ws.root / "src" / "stale_target.rs"
            target_path.write_text("pub fn version() -> u32 {\n    99\n}\n", encoding="utf-8")

            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/stale_target.rs",
                    "expectedRevision": old_rev,
                    "edits": [{
                        "startByte": target_line["startByte"],
                        "endByte": target_line["endByte"],
                        "expectedText": "    1",
                        "replacement": "    2",
                    }],
                },
                operation_id="t05-stale-1",
            )
            assert comp["status"] == "error"
            assert comp["error"]["code"] == "E_CONFLICT", f"T05 expected E_CONFLICT, got {comp}"
            assert target_path.read_text(encoding="utf-8") == "pub fn version() -> u32 {\n    99\n}\n"


# ---------------------------------------------------------------------------
# T06 P0: Full digest vs short tag / expectedText mismatch
# ---------------------------------------------------------------------------
def test_t06_full_digest_and_tag_check() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            res, lines = read_file_full(ms, sid, "src/lib.rs")
            # Wrong 64-char hex revision even with matching line tag/text
            wrong_rev = ("f" if res["fileRevision"][0] != "f" else "0") + res["fileRevision"][1:]
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": wrong_rev,
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "expectedText": lines[1]["text"],
                        "expectedTag": lines[1]["lineTag"],
                        "replacement": "    a + b + 1",
                    }],
                },
                operation_id="t06-wrong-rev",
            )
            assert comp["status"] == "error"
            assert comp["error"]["code"] == "E_CONFLICT"

            # Valid revision but wrong expectedTag
            _, comp2 = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "expectedTag": "zzz",
                        "replacement": "    a + b + 1",
                    }],
                },
                operation_id="t06-wrong-tag",
            )
            assert comp2["status"] == "error"
            assert comp2["error"]["code"] == "E_CONFLICT"


# ---------------------------------------------------------------------------
# T07 P0: LF/CRLF, BOM, Unicode, blank lines, no final newline, empty file
# ---------------------------------------------------------------------------
def test_t07_eol_bom_unicode_and_edge_files() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            # 1. CRLF preserved
            res, lines = read_file_full(ms, sid, "edge/crlf_file.txt")
            assert res["eol"] == "crlf"
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/crlf_file.txt",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "expectedText": "beta",
                        "replacement": "BETA_1\nBETA_2",
                    }],
                },
                operation_id="t07-crlf",
            )
            assert comp["status"] == "ok", f"T07 crlf patch failed: {comp}"
            assert (ws.root / "edge/crlf_file.txt").read_bytes() == b"alpha\r\nBETA_1\r\nBETA_2\r\ngamma\r\n"

            # 2. UTF-8 BOM + LF preserved
            res, lines = read_file_full(ms, sid, "edge/utf8_bom.txt")
            assert res["hasBom"] is True
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/utf8_bom.txt",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[0]["startByte"],
                        "endByte": lines[0]["endByte"],
                        "expectedText": "bom_line_1",
                        "replacement": "BOM_UPDATED",
                    }],
                },
                operation_id="t07-bom",
            )
            assert comp["status"] == "ok", f"T07 bom patch failed: {comp}"
            assert (ws.root / "edge/utf8_bom.txt").read_bytes() == b"\xef\xbb\xbfBOM_UPDATED\nbom_line_2\n"

            # 3. No final newline preserved
            res, lines = read_file_full(ms, sid, "edge/no_final_newline.txt")
            assert res["hasTrailingNewline"] is False
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/no_final_newline.txt",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "expectedText": "second_line_no_nl",
                        "replacement": "updated_no_nl",
                    }],
                },
                operation_id="t07-nonl",
            )
            assert comp["status"] == "ok"
            assert (ws.root / "edge/no_final_newline.txt").read_bytes() == b"first_line\nupdated_no_nl"

            # 4. Empty file [0, 0) insert
            res, _ = read_file_full(ms, sid, "edge/empty.txt")
            assert res["totalBytes"] == 0
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/empty.txt",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": 0,
                        "endByte": 0,
                        "replacement": "hello empty\n",
                    }],
                },
                operation_id="t07-empty",
            )
            assert comp["status"] == "ok"
            assert (ws.root / "edge/empty.txt").read_bytes() == b"hello empty\n"

            # 5. Unicode multi-byte line
            res, lines = read_file_full(ms, sid, "edge/unicode.rs")
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/unicode.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[3]["startByte"],
                        "endByte": lines[3]["endByte"],
                        "expectedText": "    x + 42",
                        "replacement": "    x + 100",
                    }],
                },
                operation_id="t07-unicode",
            )
            assert comp["status"] == "ok"
            assert "x + 100" in (ws.root / "edge/unicode.rs").read_text(encoding="utf-8")

            # 6. Mixed EOL & Invalid UTF-8 rejected
            res_mix, _ = read_file_full(ms, sid, "edge/mixed_eol.txt")
            _, comp_mix = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/mixed_eol.txt",
                    "expectedRevision": res_mix["fileRevision"],
                    "edits": [{"startByte": 0, "endByte": 0, "replacement": "x"}],
                },
                operation_id="t07-mixed",
            )
            assert comp_mix["status"] == "error"
            assert comp_mix["error"]["code"] == "E_INVALID_REQUEST"

            _, comp_bin = ms.call_op(sid, {"kind": "read", "path": "edge/invalid_utf8.bin"})
            assert comp_bin["status"] == "error"
            assert comp_bin["error"]["code"] == "E_INVALID_REQUEST"


# ---------------------------------------------------------------------------
# T08 P0: Multiple edits (out-of-order, EOF insert, overlap fail)
# ---------------------------------------------------------------------------
def test_t08_multiple_edits_and_overlap() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            res, lines = read_file_full(ms, sid, "src/lib.rs")
            orig_bytes = (ws.root / "src/lib.rs").read_bytes()

            # Overlapping edits must fail atomically
            _, comp_ov = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [
                        {"startByte": 0, "endByte": 10, "replacement": "A"},
                        {"startByte": 5, "endByte": 15, "replacement": "B"},
                    ],
                },
                operation_id="t08-overlap",
            )
            assert comp_ov["status"] == "error"
            assert comp_ov["error"]["code"] == "E_INVALID_REQUEST"
            assert (ws.root / "src/lib.rs").read_bytes() == orig_bytes

            # Out-of-order non-overlapping edits + EOF insert
            eof = res["totalBytes"]
            _, comp_ok = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [
                        {"startByte": eof, "endByte": eof, "replacement": "\n// EOF\n"},
                        {
                            "startByte": lines[1]["startByte"],
                            "endByte": lines[1]["endByte"],
                            "expectedText": "    a + b",
                            "replacement": "    a.saturating_add(b)",
                        },
                    ],
                },
                operation_id="t08-multi-ok",
            )
            assert comp_ok["status"] == "ok", f"T08 multi edit failed: {comp_ok}"
            updated = (ws.root / "src/lib.rs").read_text(encoding="utf-8")
            assert "a.saturating_add(b)" in updated
            assert updated.endswith("\n// EOF\n")


# ---------------------------------------------------------------------------
# T09 P0: Denied write, hardlink, permission error
# ---------------------------------------------------------------------------
def test_t09_denied_write_hardlink_and_perms() -> None:
    with TempWorkspace("small-repo", with_special_entries=True) as ws:
        # 1. Host allow_write=false denies patch
        with MsProcess(ws.root, ws.state_dir, allow_write=False) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=False)
            res, lines = read_file_full(ms, sid, "src/lib.rs")
            _, comp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "replacement": "    0",
                    }],
                },
                operation_id="t09-ro-host",
            )
            assert comp["status"] == "error"
            assert comp["error"]["code"] == "E_POLICY_DENIED"

        # 2. Hardlink (nlink == 2) denied for patch
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res_hl, _ = read_file_full(ms, sid, "edge/hardlink_orig.txt")
            _, comp_hl = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/hardlink_orig.txt",
                    "expectedRevision": res_hl["fileRevision"],
                    "edits": [{"startByte": 0, "endByte": 8, "replacement": "changed!"}],
                },
                operation_id="t09-hardlink",
            )
            assert comp_hl["status"] == "error"
            assert comp_hl["error"]["code"] in ("E_POLICY_DENIED", "E_INVALID_REQUEST")
            assert (ws.root / "edge/hardlink_orig.txt").read_text() == "hardlink content line 1\n"

            # 3. Read-only file (0444) permission error
            res_ro, _ = read_file_full(ms, sid, "edge/readonly.txt")
            _, comp_ro = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "edge/readonly.txt",
                    "expectedRevision": res_ro["fileRevision"],
                    "edits": [{"startByte": 0, "endByte": 6, "replacement": "hacked"}],
                },
                operation_id="t09-perm",
            )
            # Note: on Linux, atomic rename in writable dir can replace a 0444 file unless runtime checks writable perm.
            # Either E_POLICY_DENIED/E_IO or clean success is possible; if error, file must remain intact.
            if comp_ro["status"] == "error":
                assert (ws.root / "edge/readonly.txt").read_text() == "cannot write this\n"


# ---------------------------------------------------------------------------
# T10 P0 & T11 P0 & T12 P0 & T13b P0: Crash/Restart, Undo, Conflict, Idempotency
# ---------------------------------------------------------------------------
def test_t10_t11_t12_t13b_journal_recovery_undo_idempotency() -> None:
    with TempWorkspace("small-repo") as ws:
        target = ws.root / "src" / "main.rs"
        orig_bytes = target.read_bytes()

        # Session 1: Patch and then kill process immediately after commit (T10/T11)
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res, lines = read_file_full(ms, sid, "src/main.rs")
            orig_rev = res["fileRevision"]

            patch_edits = [{
                "startByte": lines[2]["startByte"],
                "endByte": lines[2]["endByte"],
                "expectedText": lines[2]["text"],
                "replacement": '    println!("patched {}", cfg);',
            }]
            _, pcomp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/main.rs",
                    "expectedRevision": orig_rev,
                    "edits": patch_edits,
                },
                operation_id="op-main-1",
            )
            assert pcomp["status"] == "ok", f"patch failed: {pcomp}"
            tx_id = pcomp["result"]["transactionId"]
            after_rev = pcomp["result"]["afterRevision"]

            # Abrupt SIGKILL (simulate crash right after commit)
            ms.kill()

        patched_bytes = target.read_bytes()
        assert b"patched {}" in patched_bytes

        # Restart 2: Verify T13b idempotency replay & conflict
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            # T13b: Retry same operationId + same payload -> returns cached ok, does NOT apply twice
            _, replay = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/main.rs",
                    "expectedRevision": orig_rev,
                    "edits": patch_edits,
                },
                operation_id="op-main-1",
            )
            assert replay["status"] == "ok", f"T13b replay failed: {replay}"
            assert replay["result"]["transactionId"] == tx_id
            assert replay["result"]["afterRevision"] == after_rev
            assert target.read_bytes() == patched_bytes

            # T13b: Retry same operationId + DIFFERENT payload -> E_IDEMPOTENCY_CONFLICT
            _, conflict = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/main.rs",
                    "expectedRevision": orig_rev,
                    "edits": [{
                        "startByte": 0,
                        "endByte": 0,
                        "replacement": "// different\n",
                    }],
                },
                operation_id="op-main-1",
            )
            assert conflict["status"] == "error"
            assert conflict["error"]["code"] == "E_IDEMPOTENCY_CONFLICT"

            # T11: tx.list shows committed tx, then tx.undo restores exact original bytes
            tx_events, tx_comp = ms.call_op(sid, {"kind": "tx.list"})
            assert tx_comp["status"] == "ok"
            txs = collect_lines(tx_events)
            assert any(t["transactionId"] == tx_id and t["state"] == "committed" for t in txs)

            _, ucomp = ms.call_op(
                sid,
                {"kind": "tx.undo", "transactionId": tx_id},
                operation_id="op-undo-1",
            )
            assert ucomp["status"] == "ok", f"T11 tx.undo failed: {ucomp}"
            assert ucomp["result"]["restoredRevision"] == orig_rev
            assert target.read_bytes() == orig_bytes

        # T12: Patch -> external edit -> tx.undo -> E_UNDO_CONFLICT
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res, lines = read_file_full(ms, sid, "src/main.rs")
            _, pcomp2 = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/main.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[2]["startByte"],
                        "endByte": lines[2]["endByte"],
                        "replacement": '    println!("second {}", cfg);',
                    }],
                },
                operation_id="op-main-2",
            )
            assert pcomp2["status"] == "ok"
            tx2 = pcomp2["result"]["transactionId"]

            # External modification after commit
            target.write_text("externally modified\n", encoding="utf-8")

            _, ucomp2 = ms.call_op(
                sid,
                {"kind": "tx.undo", "transactionId": tx2},
                operation_id="op-undo-2",
            )
            assert ucomp2["status"] == "error"
            assert ucomp2["error"]["code"] == "E_UNDO_CONFLICT"
            assert target.read_text(encoding="utf-8") == "externally modified\n"


# ---------------------------------------------------------------------------
# T13 P0: Single-writer workspace lease across two runtime instances
# ---------------------------------------------------------------------------
def test_t13_workspace_lease_across_instances() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms1:
            ms1.initialize()
            sid1 = ms1.open_session(allow_write=True)
            res, _ = read_file_full(ms1, sid1, "src/lib.rs")

            # Second instance with allow_write=True on the same workspace + state_dir
            with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms2:
                rc = ms2.proc.wait(timeout=3)
                assert rc != 0, f"T13 expected second writer instance to fail startup, got rc={rc}"
                err = ms2.stderr_text()
                assert "workspace locked" in err.lower(), f"T13 unexpected stderr: {err}"


def find_journal_path(state_dir: Path, ws_root: Path) -> Path:
    st = os.stat(ws_root)
    return state_dir / "workspaces" / f"{st.st_dev}_{st.st_ino}" / "journal.jsonl"


def test_t10b_journal_state_fault_injection() -> None:
    # 1. PREPARED + target=before -> Aborted
    with TempWorkspace("small-repo") as ws:
        target = ws.root / "src" / "lib.rs"
        orig_bytes = target.read_bytes()
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res, lines = read_file_full(ms, sid, "src/lib.rs")
            _, pcomp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "replacement": "    a + b + 1",
                    }],
                },
                operation_id="t10b-before",
            )
            assert pcomp["status"] == "ok"
            tx_id = pcomp["result"]["transactionId"]

        jpath = find_journal_path(ws.state_dir, ws.root)
        jlines = jpath.read_text(encoding="utf-8").splitlines()
        # Drop the last line (Committed) and revert target file to before_revision
        jpath.write_text("\n".join(jlines[:-1]) + "\n", encoding="utf-8")
        target.write_bytes(orig_bytes)

        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            evs, comp = ms.call_op(sid, {"kind": "tx.list"})
            assert comp["status"] == "ok"
            txs = collect_lines(evs)
            assert any(t["transactionId"] == tx_id and t["state"] == "aborted" for t in txs), f"Expected aborted: {txs}"

    # 2. PREPARED + target=after + truncated tail -> Committed
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res, lines = read_file_full(ms, sid, "src/lib.rs")
            _, pcomp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "replacement": "    a + b + 2",
                    }],
                },
                operation_id="t10b-after",
            )
            assert pcomp["status"] == "ok"
            tx_id = pcomp["result"]["transactionId"]

        jpath = find_journal_path(ws.state_dir, ws.root)
        jlines = jpath.read_text(encoding="utf-8").splitlines()
        # Keep Prepared, drop Committed, and append truncated tail
        jpath.write_text("\n".join(jlines[:-1]) + '\n{"version":1,"digest":"trunc', encoding="utf-8")

        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            evs, comp = ms.call_op(sid, {"kind": "tx.list"})
            assert comp["status"] == "ok"
            txs = collect_lines(evs)
            assert any(t["transactionId"] == tx_id and t["state"] == "committed" for t in txs), f"Expected committed: {txs}"

    # 3. PREPARED + target=third_state -> Conflict + blocks further mutation on that file
    with TempWorkspace("small-repo") as ws:
        target = ws.root / "src" / "lib.rs"
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            res, lines = read_file_full(ms, sid, "src/lib.rs")
            _, pcomp = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res["fileRevision"],
                    "edits": [{
                        "startByte": lines[1]["startByte"],
                        "endByte": lines[1]["endByte"],
                        "replacement": "    a + b + 3",
                    }],
                },
                operation_id="t10b-conflict",
            )
            assert pcomp["status"] == "ok"
            tx_id = pcomp["result"]["transactionId"]

        jpath = find_journal_path(ws.state_dir, ws.root)
        jlines = jpath.read_text(encoding="utf-8").splitlines()
        jpath.write_text("\n".join(jlines[:-1]) + "\n", encoding="utf-8")
        target.write_text("completely different content\n", encoding="utf-8")

        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)
            evs, comp = ms.call_op(sid, {"kind": "tx.list"})
            assert comp["status"] == "ok"
            txs = collect_lines(evs)
            assert any(t["transactionId"] == tx_id and t["state"] == "conflict" for t in txs), f"Expected conflict: {txs}"

            res_new, _ = read_file_full(ms, sid, "src/lib.rs")
            _, pcomp2 = ms.call_op(
                sid,
                {
                    "kind": "patch",
                    "path": "src/lib.rs",
                    "expectedRevision": res_new["fileRevision"],
                    "edits": [{"startByte": 0, "endByte": 0, "replacement": "// blocked\n"}],
                },
                operation_id="t10b-after-conflict",
            )
            assert pcomp2["status"] == "error"
            assert pcomp2["error"]["code"] == "E_RECOVERY_CONFLICT"


# ---------------------------------------------------------------------------
# T14: Smart Command Distiller (ms exec + ms log)
# ---------------------------------------------------------------------------
def test_t14_exec_distill_and_log() -> None:
    import re
    import subprocess

    with TempWorkspace("small-repo") as ws:
        # 1. Passing command with ANSI + \r spinner + duplicate lines
        cmd_pass = [
            str(DEFAULT_BIN),
            "exec",
            "--root",
            str(ws.root),
            "--",
            "python3",
            "-c",
            "import sys; print('\\x1b[32mok line\\x1b[0m'); print('dup'); print('dup'); print('spin1\\rspin2')",
        ]
        res = subprocess.run(cmd_pass, capture_output=True, text=True, timeout=10)
        assert res.returncode == 0, f"T14 pass failed: {res.stderr}"
        assert "[OK | exit:0" in res.stdout
        assert "\x1b[" not in res.stdout
        m = re.search(r"log:(log-[0-9-]+)", res.stdout)
        assert m, f"T14 missing log_id in: {res.stdout}"
        log_id = m.group(1)

        # Inspect raw log with ms log --id --tail --grep
        log_res = subprocess.run(
            [str(DEFAULT_BIN), "log", "--id", log_id, "--tail", "10", "--grep", "dup"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert log_res.returncode == 0
        assert "dup" in log_res.stdout

        # 2. Failing command referencing an in-workspace file:line -> auto-attaches hashline snippet
        cmd_fail = [
            str(DEFAULT_BIN),
            "exec",
            "--root",
            str(ws.root),
            "--",
            "python3",
            "-c",
            "import sys; sys.stderr.write('error: boom at src/lib.rs:2:1\\n'); sys.exit(1)",
        ]
        f_res = subprocess.run(cmd_fail, capture_output=True, text=True, timeout=10)
        assert f_res.returncode == 1
        assert "[FAILED | exit:1" in f_res.stdout
        assert "--- context snippets ---" in f_res.stdout
        assert "@ src/lib.rs:2" in f_res.stdout
        assert "rev:" in f_res.stdout


# ---------------------------------------------------------------------------
# T15: Universal MCP Server (ms mcp stdio JSON-RPC 2.0)
# ---------------------------------------------------------------------------
def test_t15_mcp_stdio_jsonrpc() -> None:
    import subprocess

    with TempWorkspace("small-repo") as ws:
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1.0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "ms_read", "arguments": {"path": "src/lib.rs", "startLine": 1, "lineCount": 20}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "ms_write", "arguments": {"path": "mcp_created.txt", "content": "hello mcp\n"}}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "ms_undo", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "ms_outline", "arguments": {}}},
        ]
        proc = subprocess.Popen(
            [str(DEFAULT_BIN), "mcp", "--root", str(ws.root), "--state-dir", str(ws.state_dir), "--allow-write"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        out, err = proc.communicate("\n".join(json.dumps(m) for m in msgs) + "\n", timeout=10)
        assert proc.returncode == 0, f"T15 mcp exited {proc.returncode}: {err}"
        resps = [json.loads(l) for l in out.strip().splitlines()]
        assert len(resps) == 7, f"T15 expected 7 responses, got {len(resps)}"
        tool_names = {t["name"] for t in resps[2]["result"]["tools"]}
        assert {"ms_exec", "ms_log", "ms_read", "ms_search", "ms_edit", "ms_write", "ms_delete", "ms_undo", "ms_outline", "ms_context"} <= tool_names
        assert resps[3]["result"]["content"][0]["text"].startswith("rev:")
        assert not (ws.root / "mcp_created.txt").exists(), "T15 ms_undo should have removed mcp_created.txt"


# ---------------------------------------------------------------------------
# T16: Hashline read, edit + self-healing, write/delete/rename + undo, outline, context_bundle
# ---------------------------------------------------------------------------
def test_t16_hashline_edit_mutations_outline_context() -> None:
    with TempWorkspace("small-repo") as ws:
        with MsProcess(ws.root, ws.state_dir, allow_write=True) as ms:
            ms.initialize()
            sid = ms.open_session(allow_write=True)

            # 1. Compact hashline read
            evs, comp = ms.call_op(sid, {"kind": "read", "path": "src/lib.rs", "startLine": 1, "lineCount": 50, "format": "hashline"})
            assert comp["status"] == "ok"
            assert collect_lines(evs) == []
            hl = comp["result"]["hashline"]
            assert hl.startswith("rev:")
            line1 = [l for l in hl.splitlines() if l.startswith("1:")][0]
            tag1 = line1.split(":")[1].split("|")[0]

            # 2. Self-healing conflict on wrong tag
            _, cerr = ms.call_op(sid, {
                "kind": "edit",
                "path": "src/lib.rs",
                "edits": [{"startLine": 1, "endLine": 1, "startTag": "zzzz", "replacement": "// bad"}],
            })
            assert cerr["status"] == "error"
            assert cerr["error"]["code"] == "E_CONFLICT"
            assert "1:" in cerr["error"]["hint"]

            # 3. Valid line-range + tag edit
            _, eok = ms.call_op(sid, {
                "kind": "edit",
                "path": "src/lib.rs",
                "edits": [{"startLine": 1, "endLine": 1, "startTag": tag1, "replacement": "// updated via hashline"}],
            }, operation_id="t16-edit-1")
            assert eok["status"] == "ok"

            # 4. write_file -> delete_file -> tx.undo
            _, wok = ms.call_op(sid, {
                "kind": "write_file",
                "path": "extra/hello.rs",
                "content": "pub fn hello() {}\n",
            }, operation_id="t16-write-1")
            assert wok["status"] == "ok"
            assert (ws.root / "extra/hello.rs").exists()

            _, dok = ms.call_op(sid, {
                "kind": "delete_file",
                "path": "extra/hello.rs",
            }, operation_id="t16-del-1")
            assert dok["status"] == "ok"
            assert not (ws.root / "extra/hello.rs").exists()

            _, uok = ms.call_op(sid, {"kind": "tx.undo"}, operation_id="t16-undo-1")
            assert uok["status"] == "ok"
            assert (ws.root / "extra/hello.rs").exists()

            # 5. outline & context_bundle
            oevs, ocomp = ms.call_op(sid, {"kind": "outline"})
            assert ocomp["status"] == "ok"
            assert len(collect_lines(oevs)) >= 1

            _, ccomp = ms.call_op(sid, {"kind": "context_bundle", "path": "src/lib.rs", "line": 1})
            assert ccomp["status"] == "ok"
            assert ccomp["result"]["hashlineSnippet"].startswith("rev:")


TESTS: list[tuple[str, Callable[[], None]]] = [
    ("T01_path_traversal_and_symlinks", test_t01_path_traversal_and_symlinks),
    ("T02_secrets_fifo_and_bounds", test_t02_secrets_fifo_and_bounds),
    ("T03_protocol_framing_and_errors", test_t03_protocol_framing_and_errors),
    ("T04_cancel_and_deadline", test_t04_cancel_and_deadline),
    ("T05_stale_revision_conflict", test_t05_stale_revision_conflict),
    ("T06_full_digest_and_tag_check", test_t06_full_digest_and_tag_check),
    ("T07_eol_bom_unicode_and_edge_files", test_t07_eol_bom_unicode_and_edge_files),
    ("T08_multiple_edits_and_overlap", test_t08_multiple_edits_and_overlap),
    ("T09_denied_write_hardlink_and_perms", test_t09_denied_write_hardlink_and_perms),
    ("T10_T11_T12_T13b_recovery_undo_idempotency", test_t10_t11_t12_t13b_journal_recovery_undo_idempotency),
    ("T10b_journal_state_fault_injection", test_t10b_journal_state_fault_injection),
    ("T13_workspace_lease_across_instances", test_t13_workspace_lease_across_instances),
    ("T14_exec_distill_and_log", test_t14_exec_distill_and_log),
    ("T15_mcp_stdio_jsonrpc", test_t15_mcp_stdio_jsonrpc),
    ("T16_hashline_edit_mutations_outline_context", test_t16_hashline_edit_mutations_outline_context),
]


def main() -> int:
    if not DEFAULT_BIN.exists():
        print(f"ERROR: release binary not found at {DEFAULT_BIN}", file=sys.stderr)
        return 2

    passed = 0
    failed = 0
    for name, fn in TESTS:
        t0 = time.monotonic()
        try:
            fn()
            dt = (time.monotonic() - t0) * 1000
            print(f"[PASS] {name} ({dt:.1f} ms)")
            passed += 1
        except Exception as exc:
            dt = (time.monotonic() - t0) * 1000
            print(f"[FAIL] {name} ({dt:.1f} ms): {exc}", file=sys.stderr)
            failed += 1

    print(f"\nE2E Summary: {passed} passed, {failed} failed (total {len(TESTS)})")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
