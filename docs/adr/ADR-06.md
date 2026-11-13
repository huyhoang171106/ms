# ADR-06: Full BLAKE3 File Revision; Short Line Tag Is Advisory Only

**Status:** Accepted

## Context
Short line hashes (e.g., 3 hex chars = 12 bits) have high collision probability and do not protect against edits elsewhere in the file.

## Decision
Every `read` returns a full 64-char hex BLAKE3 `fileRevision` over the entire file snapshot. `patch` requires `expectedRevision` to match the full file digest; short `lineTag` values are only optional UI/diagnostic anchors.

## Consequences
- Eliminates silent hash-collision corruption and whole-file drift between read and patch.
