# ADR-07: Single-File Durable Transactions and Precondition-Checked Undo

**Status:** Accepted

## Context
Multi-file atomicity and arbitrary `rollback(txId)` require complex dependency graphs and cross-file locking.

## Decision
MVP K2 supports single-file regular-file mutations (`patch`, `tx.undo`) backed by a durable write-ahead journal (`PREPARED` -> temp file + `fsync` -> revalidate -> atomic `rename` + dir `fsync` -> `COMMITTED`). `tx.undo` only undoes the latest un-undone transaction when the current file digest matches `afterRevision`, otherwise returning `E_UNDO_CONFLICT`.

## Consequences
- Crash recovery deterministically classifies interrupted transactions as `before`, `after`, or `conflict`.
- Undo is itself a durable transaction and never silently overwrites newer edits.
