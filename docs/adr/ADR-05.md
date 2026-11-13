# ADR-05: Cooperative Single-Writer Workspace Lease

**Status:** Accepted

## Context
Multiple sessions or `ms` instances targeting the same workspace (even via path aliases) must not race on journal/preimage writes.

## Decision
Map each workspace root's `(dev, ino)` identity to a single lock/state authority in `state_dir`. Only one writer holds the workspace lease at a time; a second writer is rejected with `E_WORKSPACE_LOCKED`.

## Consequences
- Serializes mutations per workspace across sessions and `ms` instances.
- Explicitly documented as cooperative: it does not prevent external editors outside `ms` from modifying files.
