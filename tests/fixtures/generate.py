#!/usr/bin/env python3
"""Deterministic fixture corpus generator for `ms` tests and benchmarks."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def generate_small_repo(root: Path) -> None:
    if root.exists():
        import shutil
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    # 1. Standard LF Rust source files
    write_bytes(
        root / "src" / "main.rs",
        (
            "fn main() {\n"
            "    let cfg = load_config();\n"
            "    println!(\"hello {}\", cfg);\n"
            "}\n"
            "\n"
            "fn load_config() -> &'static str {\n"
            "    \"default\"\n"
            "}\n"
        ).encode("utf-8"),
    )

    write_bytes(
        root / "src" / "lib.rs",
        (
            "pub fn add(a: i64, b: i64) -> i64 {\n"
            "    a + b\n"
            "}\n"
            "\n"
            "pub fn multiply(a: i64, b: i64) -> i64 {\n"
            "    a * b\n"
            "}\n"
        ).encode("utf-8"),
    )

    # 2. Filename with spaces
    write_bytes(
        root / "src" / "my module.rs",
        (
            "pub fn greet_space() -> &'static str {\n"
            "    \"space_ok\"\n"
            "}\n"
        ).encode("utf-8"),
    )
    write_bytes(
        root / "docs" / "notes with spaces.md",
        (
            "# Notes\n"
            "\n"
            "Line two with space filename.\n"
        ).encode("utf-8"),
    )

    # 3. CRLF file
    write_bytes(
        root / "edge" / "crlf_file.txt",
        b"alpha\r\nbeta\r\ngamma\r\n",
    )

    # 4. UTF-8 BOM + LF
    write_bytes(
        root / "edge" / "utf8_bom.txt",
        b"\xef\xbb\xbfbom_line_1\nbom_line_2\n",
    )

    # 5. UTF-8 BOM + CRLF
    write_bytes(
        root / "edge" / "utf8_bom_crlf.txt",
        b"\xef\xbb\xbfbom_crlf_1\r\nbom_crlf_2\r\n",
    )

    # 6. No final newline
    write_bytes(
        root / "edge" / "no_final_newline.txt",
        b"first_line\nsecond_line_no_nl",
    )

    # 7. Empty file
    write_bytes(root / "edge" / "empty.txt", b"")

    # 8. Mixed EOL (must be rejected by patch)
    write_bytes(
        root / "edge" / "mixed_eol.txt",
        b"line_lf\nline_crlf\r\nline_lf_2\n",
    )

    # 9. Invalid UTF-8 (must be rejected by text read/patch)
    write_bytes(
        root / "edge" / "invalid_utf8.bin",
        b"valid_prefix\n\xff\xfe\xfd\nvalid_suffix\n",
    )

    # 10. Unicode multi-byte + blank lines
    write_bytes(
        root / "edge" / "unicode.rs",
        (
            "// Xin ch\u00e0o th\u1ebf gi\u1edbi \U0001f680\n"
            "\n"
            "pub fn t\u00ednh_t\u1ed5ng(x: i32) -> i32 {\n"
            "    x + 42\n"
            "}\n"
        ).encode("utf-8"),
    )

    # 11. Stale edit target
    write_bytes(
        root / "src" / "stale_target.rs",
        (
            "pub fn version() -> u32 {\n"
            "    1\n"
            "}\n"
        ).encode("utf-8"),
    )

    # 12. .gitignore and ignored file
    write_bytes(root / ".gitignore", b"ignored_dir/\n*.tmp\n")
    write_bytes(root / "ignored_dir" / "secret_ignored.txt", b"SHOULD_BE_IGNORED\n")
    write_bytes(root / "scratch.tmp", b"TEMP_IGNORED\n")

    # 13. Secret files (for T02 policy deny tests)
    write_bytes(root / ".env", b"API_SECRET=super_secret_token_12345\n")
    write_bytes(root / "secrets" / "credentials.json", b"{\"token\":\"do_not_leak\"}\n")


def generate_large_repo(root: Path, num_modules: int = 10, files_per_module: int = 50) -> None:
    if root.exists():
        import shutil
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    write_bytes(root / ".gitignore", b"build/\n*.log\n")
    write_bytes(root / ".env", b"LARGE_REPO_SECRET=top_secret_value\n")

    for m in range(num_modules):
        mod_dir = root / "src" / f"mod_{m:02d}"
        for f in range(files_per_module):
            idx = m * files_per_module + f
            lines = [
                f"// Module {m:02d} File {f:02d} (index {idx})",
                f"pub const ID_{idx:04d}: usize = {idx};",
                "",
            ]
            for j in range(40):
                if j == 17 and idx % 25 == 0:
                    lines.append(f"pub fn target_symbol_{idx:04d}(x: i64) -> i64 {{ x + {idx} }}")
                else:
                    lines.append(
                        f"pub fn compute_metric_{idx:04d}_{j:02d}(v: i64) -> i64 {{ v.wrapping_mul({j + 1}) }}"
                    )
            content = "\n".join(lines) + "\n"
            write_bytes(mod_dir / f"file_{f:02d}.rs", content.encode("utf-8"))

    # Add a few ignored files
    write_bytes(root / "build" / "output.log", b"build log line\n" * 100)


def build_manifest(fixtures_dir: Path) -> dict:
    repos = {}
    for repo_name in ("small-repo", "large-repo"):
        repo_dir = fixtures_dir / repo_name
        entries = []
        total_bytes = 0
        for p in sorted(repo_dir.rglob("*")):
            if p.is_file():
                data = p.read_bytes()
                total_bytes += len(data)
                sha256 = hashlib.sha256(data).hexdigest()
                rel = p.relative_to(repo_dir).as_posix()
                entries.append({
                    "path": rel,
                    "sizeBytes": len(data),
                    "sha256": sha256,
                })
        repos[repo_name] = {
            "fileCount": len(entries),
            "totalBytes": total_bytes,
            "files": entries,
        }
    return {
        "schemaVersion": 1,
        "repos": repos,
    }


def main() -> None:
    generate_small_repo(FIXTURES_DIR / "small-repo")
    generate_large_repo(FIXTURES_DIR / "large-repo")
    manifest = build_manifest(FIXTURES_DIR)
    (FIXTURES_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Generated fixtures: small-repo={manifest['repos']['small-repo']['fileCount']} files "
        f"({manifest['repos']['small-repo']['totalBytes']} B), "
        f"large-repo={manifest['repos']['large-repo']['fileCount']} files "
        f"({manifest['repos']['large-repo']['totalBytes']} B)"
    )


if __name__ == "__main__":
    main()
