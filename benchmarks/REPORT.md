# `ms` Benchmark Report

## Machine & Tool Versions
- **Timestamp (UTC)**: `2026-11-14T13:22:50Z`
- **OS / Kernel**: `Linux-7.0.0-43-generic-x86_64-with-glibc2.39`
- **CPU**: `12th Gen Intel(R) Core(TM) i5-12450HX`
- **Memory**: `28433676 kB`
- **Rustc**: `rustc 1.98.1 (48a229cea 2026-09-01)`
- **ripgrep**: `ripgrep 14.1.0`
- **fd**: `fdfind 9.0.0`
- **Python**: `3.12.3`
- **Iterations**: `7` per scenario

## Results

| Scenario | Tool / Mode | Correct | Median (ms) | p95 (ms) | Peak RSS (KB) | Output (B) | Calls |
|---|---|---|---:|---:|---:|---:|---:|
| list_large_repo_501_files | ms (warm session) | True | 2.778 | 4.456 | - | 36131 | 1 |
| list_large_repo_501_files | ms (cold process) | True | 7.642 | 9.158 | 7740 | 36131 | 1 |
| list_large_repo_501_files | baseline (`fdfind --type f --max-results 1000`) | True | 4.742 | 5.82 | 5320 | 11017 | 1 |
| search_symbol_large_repo | ms (warm session) | True | 3.482 | 7.045 | - | 420 | 1 |
| search_symbol_large_repo | ms (cold process) | True | 8.411 | 9.075 | 6852 | 420 | 1 |
| search_symbol_large_repo | baseline (`rg -n --fixed-strings --max-count 50 target_symbol_0100`) | True | 7.061 | 8.074 | 7648 | 78 | 1 |
| read_bounded_20_lines | ms (warm session) | True | 0.182 | 0.331 | - | 3518 | 1 |
| read_bounded_20_lines | ms (cold process) | True | 4.51 | 5.216 | 6004 | 3518 | 1 |
| read_bounded_20_lines | baseline (`python3 -c '<slice lines 10..30>'`) | True | 22.433 | 24.99 | 12080 | 1422 | 1 |
| read_plus_patch_small_repo | ms (cold process) | True | 4.535 | 7.014 | 6096 | 1618 | 2 |
| read_plus_patch_small_repo | baseline (`python3 -c '<read + replace + write>' (no revision check/journal/undo)`) | True | 20.449 | 22.803 | 12076 | 0 | 1 |
| stale_edit_conflict_detection | ms (cold process) | True | 4.114 | 4.307 | 5952 | 1632 | 2 |

## Token-Efficiency & Distiller Comparisons (2026-11-14)

| Benchmark | Baseline | `ms` Upgraded | Savings / Speedup |
|---|---|---|---|
| `search` (`large-repo`, warm vs `rg --json`) | `rg`: 6.46 ms (256 B) | `ms search`: 3.94 ms (314 B) | **1.64x faster** (no per-line BLAKE3) |
| `read` (200 lines of `ops.rs`) | `fs.readFile` full: 67,625 B / `ms read` JSON: 1.50 ms (24,210 B) | `ms read` hashline: 0.84 ms (8,065 B) | **66.7% fewer bytes** vs JSON (**88.1%** vs full file), **1.79x faster** |
| `exec` (`cargo test --workspace`) | raw: 87 lines / 3,327 B | `ms exec`: 2 lines / 136 B | **95.9% fewer bytes** |
| `exec` (`git diff`) | raw: 4,736 lines / 178,017 B | `ms exec`: 83 lines / 4,409 B | **97.5% fewer bytes** |

