#!/usr/bin/env python3
"""Reproducible benchmark suite comparing `ms` against bounded baseline tools."""

from __future__ import annotations

import json
import math
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests" / "e2e"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests" / "fixtures"))

from ms_client import DEFAULT_BIN, MsProcess
from workspace_helper import TempWorkspace

BENCH_DIR = Path(__file__).resolve().parent
ITERATIONS = 7  # >= 5 required


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    idx = math.ceil((pct / 100.0) * len(ordered)) - 1
    idx = max(0, min(idx, len(ordered) - 1))
    return ordered[idx]


def run_subprocess_measured(cmd: list[str], cwd: Path, stdin_bytes: bytes | None = None) -> tuple[float, int, int, bytes]:
    """Run a subprocess via `/usr/bin/time -f %M` to capture exact wall ms, true child max RSS KB, and stdout bytes."""
    import tempfile
    with tempfile.NamedTemporaryFile(prefix="ms_rss_", suffix=".txt", delete=True) as tf:
        wrapped = ["/usr/bin/time", "-f", "%M", "-o", tf.name, *cmd]
        t0 = time.perf_counter()
        proc = subprocess.Popen(
            wrapped,
            cwd=cwd,
            stdin=subprocess.PIPE if stdin_bytes is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        out, _ = proc.communicate(input=stdin_bytes)
        dt_ms = (time.perf_counter() - t0) * 1000.0
        rss_text = Path(tf.name).read_text(encoding="utf-8").strip().splitlines()
        rss_kb = int(rss_text[-1]) if rss_text else 0
        return dt_ms, rss_kb, proc.returncode, out


def measure_ms_oneshot(
    root: Path,
    state_dir: Path,
    allow_write: bool,
    fn: Callable[[MsProcess, str], tuple[bool, int, int]],
) -> tuple[float, int, bool, int, int]:
    """Cold-start `ms` process via `/usr/bin/time -f %M`, run fn(ms, sid) -> (correct, out_bytes, calls)."""
    import tempfile
    with tempfile.NamedTemporaryFile(prefix="ms_rss_", suffix=".txt", delete=True) as tf:
        cmd = [
            "/usr/bin/time",
            "-f",
            "%M",
            "-o",
            tf.name,
            str(DEFAULT_BIN),
            "--root",
            str(root),
            "--state-dir",
            str(state_dir),
        ]
        if allow_write:
            cmd.append("--allow-write")

        t0 = time.perf_counter()
        ms = MsProcess.__new__(MsProcess)
        ms.root = root
        ms.state_dir = state_dir
        ms.allow_write = allow_write
        ms.binary = DEFAULT_BIN
        ms.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ms._stderr_chunks = []
        import threading
        ms._stderr_thread = threading.Thread(target=ms._drain_stderr, daemon=True)
        ms._stderr_thread.start()
        ms._req_counter = 0

        try:
            ms.initialize()
            sid = ms.open_session(allow_write=allow_write)
            correct, out_bytes, calls = fn(ms, sid)
            ms.close_session(sid)
            ms.close()
        finally:
            if ms.proc.poll() is None:
                ms.kill()
        dt_ms = (time.perf_counter() - t0) * 1000.0
        rss_text = Path(tf.name).read_text(encoding="utf-8").strip().splitlines()
        rss_kb = int(rss_text[-1]) if rss_text else 0
        return dt_ms, rss_kb, correct, out_bytes, calls


def summarize_samples(samples: list[tuple[float, int, bool, int, int]]) -> dict[str, Any]:
    latencies = [s[0] for s in samples]
    rss_vals = [s[1] for s in samples]
    all_correct = all(s[2] for s in samples)
    out_bytes = samples[-1][3]
    calls = samples[-1][4]
    return {
        "iterations": len(samples),
        "correct": all_correct,
        "medianMs": round(statistics.median(latencies), 3),
        "p95Ms": round(percentile(latencies, 95), 3),
        "minMs": round(min(latencies), 3),
        "maxMs": round(max(latencies), 3),
        "maxRssKb": max(rss_vals),
        "outputBytes": out_bytes,
        "calls": calls,
    }


def bench_list_large() -> dict[str, Any]:
    fd_bin = shutil.which("fdfind") or shutil.which("fd")
    assert fd_bin is not None, "fdfind/fd not found"

    ms_warm_lat: list[float] = []
    ms_warm_bytes = 0
    ms_warm_correct = True
    ms_cold_samples = []
    base_samples = []

    with TempWorkspace("large-repo") as ws:
        # Warm ms session
        with MsProcess(ws.root, ws.state_dir) as ms:
            ms.initialize()
            sid = ms.open_session()
            for _ in range(ITERATIONS):
                t0 = time.perf_counter()
                evs, comp = ms.call_op(sid, {"kind": "list", "recursive": True, "maxEntries": 1000})
                dt = (time.perf_counter() - t0) * 1000.0
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                file_count = sum(1 for r in recs if r.get("kind") == "file")
                ms_warm_correct = ms_warm_correct and (comp["status"] == "ok" and file_count == 501)
                ms_warm_bytes = sum(len(json.dumps(e).encode()) for e in evs)
                ms_warm_lat.append(dt)
            ms.close_session(sid)

        # Cold ms + baseline fd
        for _ in range(ITERATIONS):
            def _do_list(ms: MsProcess, sid: str) -> tuple[bool, int, int]:
                evs, comp = ms.call_op(sid, {"kind": "list", "recursive": True, "maxEntries": 1000})
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                file_count = sum(1 for r in recs if r.get("kind") == "file")
                ob = sum(len(json.dumps(e).encode()) for e in evs)
                return (comp["status"] == "ok" and file_count == 501), ob, 1

            ms_cold_samples.append(measure_ms_oneshot(ws.root, ws.state_dir, False, _do_list))

            dt, rss, rc, out = run_subprocess_measured([fd_bin, "--type", "f", "--max-results", "1000"], ws.root)
            lines = [ln for ln in out.splitlines() if ln.strip()]
            base_samples.append((dt, rss, rc == 0 and len(lines) == 501, len(out), 1))

    return {
        "scenario": "list_large_repo_501_files",
        "baselineCmd": f"{Path(fd_bin).name} --type f --max-results 1000",
        "msCold": summarize_samples(ms_cold_samples),
        "msWarm": {
            "iterations": ITERATIONS,
            "correct": ms_warm_correct,
            "medianMs": round(statistics.median(ms_warm_lat), 3),
            "p95Ms": round(percentile(ms_warm_lat, 95), 3),
            "outputBytes": ms_warm_bytes,
            "calls": 1,
        },
        "baseline": summarize_samples(base_samples),
    }


def bench_search_symbol() -> dict[str, Any]:
    rg_bin = shutil.which("rg")
    assert rg_bin is not None, "rg not found"

    ms_warm_lat: list[float] = []
    ms_warm_bytes = 0
    ms_warm_correct = True
    ms_cold_samples = []
    base_samples = []

    with TempWorkspace("large-repo") as ws:
        with MsProcess(ws.root, ws.state_dir) as ms:
            ms.initialize()
            sid = ms.open_session()
            for _ in range(ITERATIONS):
                t0 = time.perf_counter()
                evs, comp = ms.call_op(sid, {"kind": "search", "query": "target_symbol_0100", "maxMatches": 50})
                dt = (time.perf_counter() - t0) * 1000.0
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                ms_warm_correct = ms_warm_correct and (comp["status"] == "ok" and len(recs) == 1)
                ms_warm_bytes = sum(len(json.dumps(e).encode()) for e in evs)
                ms_warm_lat.append(dt)
            ms.close_session(sid)

        for _ in range(ITERATIONS):
            def _do_search(ms: MsProcess, sid: str) -> tuple[bool, int, int]:
                evs, comp = ms.call_op(sid, {"kind": "search", "query": "target_symbol_0100", "maxMatches": 50})
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                ob = sum(len(json.dumps(e).encode()) for e in evs)
                return (comp["status"] == "ok" and len(recs) == 1), ob, 1

            ms_cold_samples.append(measure_ms_oneshot(ws.root, ws.state_dir, False, _do_search))

            dt, rss, rc, out = run_subprocess_measured(
                [rg_bin, "-n", "--fixed-strings", "--max-count", "50", "target_symbol_0100"], ws.root
            )
            lines = [ln for ln in out.splitlines() if ln.strip()]
            base_samples.append((dt, rss, rc == 0 and len(lines) == 1, len(out), 1))

    return {
        "scenario": "search_symbol_large_repo",
        "baselineCmd": "rg -n --fixed-strings --max-count 50 target_symbol_0100",
        "msCold": summarize_samples(ms_cold_samples),
        "msWarm": {
            "iterations": ITERATIONS,
            "correct": ms_warm_correct,
            "medianMs": round(statistics.median(ms_warm_lat), 3),
            "p95Ms": round(percentile(ms_warm_lat, 95), 3),
            "outputBytes": ms_warm_bytes,
            "calls": 1,
        },
        "baseline": summarize_samples(base_samples),
    }


def bench_read_bounded() -> dict[str, Any]:
    ms_warm_lat: list[float] = []
    ms_warm_bytes = 0
    ms_warm_correct = True
    ms_cold_samples = []
    base_samples = []

    rel = "src/mod_04/file_00.rs"
    with TempWorkspace("large-repo") as ws:
        with MsProcess(ws.root, ws.state_dir) as ms:
            ms.initialize()
            sid = ms.open_session()
            for _ in range(ITERATIONS):
                t0 = time.perf_counter()
                evs, comp = ms.call_op(sid, {"kind": "read", "path": rel, "startLine": 10, "lineCount": 20})
                dt = (time.perf_counter() - t0) * 1000.0
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                ms_warm_correct = ms_warm_correct and (comp["status"] == "ok" and len(recs) == 20)
                ms_warm_bytes = sum(len(json.dumps(e).encode()) for e in evs)
                ms_warm_lat.append(dt)
            ms.close_session(sid)

        py_code = (
            "from pathlib import Path; "
            f"lines = Path('{rel}').read_text().splitlines()[9:29]; "
            "print('\\n'.join(f'{i+10}: {l}' for i, l in enumerate(lines)))"
        )
        for _ in range(ITERATIONS):
            def _do_read(ms: MsProcess, sid: str) -> tuple[bool, int, int]:
                evs, comp = ms.call_op(sid, {"kind": "read", "path": rel, "startLine": 10, "lineCount": 20})
                recs = [r for e in evs if e.get("type") == "records" for r in e.get("records", [])]
                ob = sum(len(json.dumps(e).encode()) for e in evs)
                return (comp["status"] == "ok" and len(recs) == 20), ob, 1

            ms_cold_samples.append(measure_ms_oneshot(ws.root, ws.state_dir, False, _do_read))
            dt, rss, rc, out = run_subprocess_measured([sys.executable, "-c", py_code], ws.root)
            base_samples.append((dt, rss, rc == 0 and len(out.splitlines()) == 20, len(out), 1))

    return {
        "scenario": "read_bounded_20_lines",
        "baselineCmd": "python3 -c '<slice lines 10..30>'",
        "msCold": summarize_samples(ms_cold_samples),
        "msWarm": {
            "iterations": ITERATIONS,
            "correct": ms_warm_correct,
            "medianMs": round(statistics.median(ms_warm_lat), 3),
            "p95Ms": round(percentile(ms_warm_lat, 95), 3),
            "outputBytes": ms_warm_bytes,
            "calls": 1,
        },
        "baseline": summarize_samples(base_samples),
    }


def bench_patch_and_stale() -> dict[str, Any]:
    ms_patch_samples = []
    base_patch_samples = []
    ms_stale_samples = []

    for i in range(ITERATIONS):
        with TempWorkspace("small-repo") as ws:
            def _do_patch(ms: MsProcess, sid: str) -> tuple[bool, int, int]:
                evs1, c1 = ms.call_op(sid, {"kind": "read", "path": "src/lib.rs", "startLine": 1, "lineCount": 10})
                lines = [r for e in evs1 if e.get("type") == "records" for r in e.get("records", [])]
                rev = c1["result"]["fileRevision"]
                evs2, c2 = ms.call_op(
                    sid,
                    {
                        "kind": "patch",
                        "path": "src/lib.rs",
                        "expectedRevision": rev,
                        "edits": [{
                            "startByte": lines[1]["startByte"],
                            "endByte": lines[1]["endByte"],
                            "expectedText": lines[1]["text"],
                            "replacement": "    a.wrapping_add(b)",
                        }],
                    },
                    operation_id=f"bench-patch-{i}",
                )
                ok = c2["status"] == "ok" and "wrapping_add" in (ws.root / "src/lib.rs").read_text()
                ob = sum(len(json.dumps(e).encode()) for e in evs1 + evs2)
                return ok, ob, 2

            ms_patch_samples.append(measure_ms_oneshot(ws.root, ws.state_dir, True, _do_patch))

        with TempWorkspace("small-repo") as ws:
            py_edit = (
                "from pathlib import Path; "
                "p = Path('src/lib.rs'); "
                "txt = p.read_text(); "
                "p.write_text(txt.replace('    a + b', '    a.wrapping_add(b)', 1))"
            )
            dt, rss, rc, out = run_subprocess_measured([sys.executable, "-c", py_edit], ws.root)
            ok = rc == 0 and "wrapping_add" in (ws.root / "src/lib.rs").read_text()
            base_patch_samples.append((dt, rss, ok, len(out), 1))

        # Stale edit detection
        with TempWorkspace("small-repo") as ws:
            def _do_stale(ms: MsProcess, sid: str) -> tuple[bool, int, int]:
                evs1, c1 = ms.call_op(sid, {"kind": "read", "path": "src/stale_target.rs", "startLine": 1, "lineCount": 10})
                lines = [r for e in evs1 if e.get("type") == "records" for r in e.get("records", [])]
                rev = c1["result"]["fileRevision"]
                (ws.root / "src/stale_target.rs").write_text("pub fn version() -> u32 {\n    99\n}\n")
                evs2, c2 = ms.call_op(
                    sid,
                    {
                        "kind": "patch",
                        "path": "src/stale_target.rs",
                        "expectedRevision": rev,
                        "edits": [{
                            "startByte": lines[1]["startByte"],
                            "endByte": lines[1]["endByte"],
                            "replacement": "    2",
                        }],
                    },
                    operation_id=f"bench-stale-{i}",
                )
                ok = c2["status"] == "error" and c2["error"]["code"] == "E_CONFLICT"
                ob = sum(len(json.dumps(e).encode()) for e in evs1 + evs2)
                return ok, ob, 2

            ms_stale_samples.append(measure_ms_oneshot(ws.root, ws.state_dir, True, _do_stale))

    return {
        "patch": {
            "scenario": "read_plus_patch_small_repo",
            "baselineCmd": "python3 -c '<read + replace + write>' (no revision check/journal/undo)",
            "msCold": summarize_samples(ms_patch_samples),
            "baseline": summarize_samples(base_patch_samples),
        },
        "stale": {
            "scenario": "stale_edit_conflict_detection",
            "msCold": summarize_samples(ms_stale_samples),
        },
    }


def collect_metadata() -> dict[str, Any]:
    def cmd_out(cmd: list[str]) -> str:
        try:
            return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT).strip().splitlines()[0]
        except Exception:
            return "unknown"

    cpu_model = "unknown"
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except Exception:
        pass

    mem_total = "unknown"
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                mem_total = line.split(":", 1)[1].strip()
                break
    except Exception:
        pass

    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kernel": platform.platform(),
        "cpu": cpu_model,
        "memTotal": mem_total,
        "rustc": cmd_out(["rustc", "--version"]),
        "rg": cmd_out(["rg", "--version"]),
        "fd": cmd_out([shutil.which("fdfind") or "fd", "--version"]),
        "python": platform.python_version(),
        "msBinary": str(DEFAULT_BIN),
        "iterations": ITERATIONS,
    }


def write_report(meta: dict[str, Any], results: list[dict[str, Any]]) -> None:
    (BENCH_DIR / "results.json").write_text(
        json.dumps({"metadata": meta, "results": results}, indent=2) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# `ms` Benchmark Report",
        "",
        "## Machine & Tool Versions",
        f"- **Timestamp (UTC)**: `{meta['timestamp']}`",
        f"- **OS / Kernel**: `{meta['kernel']}`",
        f"- **CPU**: `{meta['cpu']}`",
        f"- **Memory**: `{meta['memTotal']}`",
        f"- **Rustc**: `{meta['rustc']}`",
        f"- **ripgrep**: `{meta['rg']}`",
        f"- **fd**: `{meta['fd']}`",
        f"- **Python**: `{meta['python']}`",
        f"- **Iterations**: `{meta['iterations']}` per scenario",
        "",
        "## Results",
        "",
        "| Scenario | Tool / Mode | Correct | Median (ms) | p95 (ms) | Peak RSS (KB) | Output (B) | Calls |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for r in results:
        sc = r["scenario"]
        if "msWarm" in r:
            w = r["msWarm"]
            lines.append(
                f"| {sc} | ms (warm session) | {w['correct']} | {w['medianMs']} | {w['p95Ms']} | - | {w['outputBytes']} | {w['calls']} |"
            )
        if "msCold" in r:
            c = r["msCold"]
            lines.append(
                f"| {sc} | ms (cold process) | {c['correct']} | {c['medianMs']} | {c['p95Ms']} | {c['maxRssKb']} | {c['outputBytes']} | {c['calls']} |"
            )
        if "baseline" in r:
            b = r["baseline"]
            lines.append(
                f"| {sc} | baseline (`{r.get('baselineCmd', '')}`) | {b['correct']} | {b['medianMs']} | {b['p95Ms']} | {b['maxRssKb']} | {b['outputBytes']} | {b['calls']} |"
            )
    lines.append("")
    (BENCH_DIR / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    if not DEFAULT_BIN.exists():
        print(f"ERROR: release binary not found at {DEFAULT_BIN}", file=sys.stderr)
        return 2

    meta = collect_metadata()
    ps = bench_patch_and_stale()
    results = [
        bench_list_large(),
        bench_search_symbol(),
        bench_read_bounded(),
        ps["patch"],
        ps["stale"],
    ]
    write_report(meta, results)
    print(f"Benchmarks complete. Wrote {BENCH_DIR / 'results.json'} and {BENCH_DIR / 'REPORT.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
