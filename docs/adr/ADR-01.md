# ADR-01: Rust, Linux-First, Pinned Toolchain and Lockfile

**Status:** Accepted

## Context
The runtime needs deterministic filesystem resolution (`openat2`), safe low-level concurrency, and predictable memory/latency without shipping a large interpreter runtime.

## Decision
Implement `ms` in Rust, targeting Linux x86_64 local filesystems first, with `rust-toolchain.toml` pinned to `1.98.1` and dependencies pinned in `Cargo.toml` / `Cargo.lock`.

## Consequences
- Avoids writing a TypeScript prototype only to port it later.
- Narrows the OS support matrix in K1/K2; Windows/macOS and network filesystems are explicitly deferred.
