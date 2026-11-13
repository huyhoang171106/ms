# ADR-04: Host-Issued Capabilities; Requests May Only Narrow

**Status:** Accepted

## Context
An untrusted client or compromised agent prompt must never escalate its own permissions via request parameters.

## Decision
The host configures `allow_write`, read/write roots, deny paths (`.git`, `state_dir`, secret paths), and `HardLimits`. `session.open` may only narrow capabilities or limits; requests to widen them are denied (`E_POLICY_DENIED` or clamped).

## Consequences
- `params.policy` / `session.open` cannot enable writes or arbitrary execution when the host forbids them.
