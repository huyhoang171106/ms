#!/usr/bin/env python3
"""Compare release RPC reads: python3 benchmarks/bench_read_window.py OLD_MS NEW_MS."""
import pathlib
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests" / "e2e"))
from ms_client import MsProcess


def measure(binary: pathlib.Path, root: pathlib.Path):
    outcomes = {}
    with MsProcess(root, binary=binary) as process:
        process.initialize()
        session = process.open_session()
        for name, start in [("small.txt", 1), ("large.txt", 1), ("large.txt", 500_000), ("large.txt", 999_996)]:
            timings = []
            expected = None
            for _ in range(22):
                began = time.perf_counter()
                events, completed = process.call_op(session, {
                    "kind": "read", "path": name, "startLine": start,
                    "lineCount": 5, "format": "json",
                })
                timings.append((time.perf_counter() - began) * 1000)
                assert completed["status"] == "ok", completed
                actual = (completed["result"], [event["records"] for event in events if event.get("type") == "records"])
                if expected is not None:
                    assert expected == actual
                expected = actual
            samples = sorted(timings[2:])
            outcomes[(name, start)] = expected
            print(f"{binary}: {name}:{start} p50={statistics.median(samples):.2f}ms p95={samples[18]:.2f}ms")
    return outcomes


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    with tempfile.TemporaryDirectory(prefix="ms-read-benchmark-") as directory:
        root = pathlib.Path(directory)
        (root / "small.txt").write_bytes(b"abcde\n" * 50)
        (root / "large.txt").write_bytes(b"abcde\n" * 1_000_000)
        before = measure(pathlib.Path(sys.argv[1]).resolve(), root)
        after = measure(pathlib.Path(sys.argv[2]).resolve(), root)
        assert before == after, "read outputs differ"


if __name__ == "__main__":
    main()
