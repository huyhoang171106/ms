# ADR-02: Structured Operations as Core; DSL Deferred to K3

**Status:** Accepted

## Context
Coding agents benefit immediately from typed RPC operations (`list`, `search`, `read`, `patch`, `tx.list`, `tx.undo`) without needing shell quoting or a custom pipeline parser.

## Decision
Build the typed `Operation` model and Protocol v1 RPC first (K1/K2). Defer the restricted DSL lexer/parser to K3, compiling it into the same typed `Operation` pipeline.

## Consequences
- Enables end-to-end agent integration and fault-injection testing before investing in grammar design.
- Prevents a split executor between CLI/DSL and RPC.
