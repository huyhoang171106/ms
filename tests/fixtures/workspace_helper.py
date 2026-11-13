#!/usr/bin/env python3
"""Isolated temporary workspace helper for `ms` E2E tests and benchmarks."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent


class TempWorkspace:
    """Context manager creating an isolated workspace + state dir + outside dir."""

    def __init__(self, repo: str = "small-repo", with_special_entries: bool = False) -> None:
        self.repo = repo
        self.with_special_entries = with_special_entries
        self._tmp: tempfile.TemporaryDirectory[str] | None = None
        self.base_dir: Path = Path()
        self.root: Path = Path()
        self.state_dir: Path = Path()
        self.outside_dir: Path = Path()

    def __enter__(self) -> "TempWorkspace":
        self._tmp = tempfile.TemporaryDirectory(prefix=f"ms_test_{self.repo}_")
        self.base_dir = Path(self._tmp.name)
        self.root = self.base_dir / "workspace"
        self.state_dir = self.base_dir / "state"
        self.outside_dir = self.base_dir / "outside"

        shutil.copytree(FIXTURES_DIR / self.repo, self.root)
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.outside_dir.mkdir(parents=True, exist_ok=True)
        (self.outside_dir / "secret_outside.txt").write_text("OUTSIDE_SECRET_DATA\n", encoding="utf-8")

        if self.with_special_entries:
            self._populate_special_entries()
        return self

    def _populate_special_entries(self) -> None:
        # Simulated .git directory
        git_dir = self.root / ".git"
        git_dir.mkdir(exist_ok=True)
        (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        (git_dir / "config").write_text("[core]\n\trepositoryformatversion = 0\n", encoding="utf-8")

        # Symlink leaf pointing outside
        os.symlink(self.outside_dir / "secret_outside.txt", self.root / "symlink_outside.txt")

        # Symlink leaf pointing inside
        os.symlink(self.root / "src" / "main.rs", self.root / "symlink_inside.rs")

        # Symlink parent directory pointing outside
        os.symlink(self.outside_dir, self.root / "symlink_dir")

        # Multi-link hardlink (nlink == 2)
        hl_target = self.root / "edge" / "hardlink_orig.txt"
        hl_target.write_text("hardlink content line 1\n", encoding="utf-8")
        os.link(hl_target, self.root / "edge" / "hardlink_alias.txt")

        # Named pipe (FIFO) special file
        os.mkfifo(self.root / "edge" / "test_fifo")

        # Read-only file (0444) for permission error test
        ro_file = self.root / "edge" / "readonly.txt"
        ro_file.write_text("cannot write this\n", encoding="utf-8")
        os.chmod(ro_file, 0o444)

    def __exit__(self, exc_type, exc, tb) -> None:
        # Restore writable permissions on any 0444 files before cleanup
        ro_file = self.root / "edge" / "readonly.txt"
        if ro_file.exists():
            try:
                os.chmod(ro_file, 0o644)
            except OSError:
                pass
        if self._tmp is not None:
            self._tmp.cleanup()
