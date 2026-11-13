# `ms` Benchmark Report

## Machine & Tool Versions
- **Timestamp (UTC)**: `2026-11-13T20:51:42Z`
- **OS / Kernel**: `Linux-7.0.0-42-generic-x86_64-with-glibc2.39`
- **CPU**: `12th Gen Intel(R) Core(TM) i5-12450HX`
- **Memory**: `28433672 kB`
- **Rustc**: `rustc 1.98.1 (48a229cea 2026-09-01)`
- **ripgrep**: `ripgrep 14.1.0`
- **fd**: `fdfind 9.0.0`
- **Python**: `3.12.3`
- **Iterations**: `7` per scenario

## Results

| Scenario | Tool / Mode | Correct | Median (ms) | p95 (ms) | Peak RSS (KB) | Output (B) | Calls |
|---|---|---|---:|---:|---:|---:|---:|
| list_large_repo_501_files | ms (warm session) | True | 2.904 | 5.76 | - | 36131 | 1 |
| list_large_repo_501_files | ms (cold process) | True | 9.619 | 10.097 | 7148 | 36131 | 1 |
| list_large_repo_501_files | baseline (`fdfind --type f --max-results 1000`) | True | 5.945 | 7.04 | 5252 | 11017 | 1 |
| search_symbol_large_repo | ms (warm session) | True | 9.574 | 13.284 | - | 420 | 1 |
| search_symbol_large_repo | ms (cold process) | True | 15.175 | 18.378 | 6032 | 421 | 1 |
| search_symbol_large_repo | baseline (`rg -n --fixed-strings --max-count 50 target_symbol_0100`) | True | 6.59 | 7.576 | 7820 | 78 | 1 |
| read_bounded_20_lines | ms (warm session) | True | 0.238 | 0.405 | - | 3518 | 1 |
| read_bounded_20_lines | ms (cold process) | True | 4.487 | 4.777 | 5152 | 3518 | 1 |
| read_bounded_20_lines | baseline (`python3 -c '<slice lines 10..30>'`) | True | 21.09 | 24.53 | 12236 | 1422 | 1 |
| read_plus_patch_small_repo | ms (cold process) | True | 4.492 | 4.654 | 5208 | 1618 | 2 |
| read_plus_patch_small_repo | baseline (`python3 -c '<read + replace + write>' (no revision check/journal/undo)`) | True | 19.667 | 22.83 | 12132 | 0 | 1 |
| stale_edit_conflict_detection | ms (cold process) | True | 4.585 | 4.955 | 5160 | 1218 | 2 |
