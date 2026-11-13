# ADR-10: No Automatic Privilege Escalation on Capability Denial

**Status:** Accepted

## Context
A headless runtime must not prompt on TTY or auto-elevate permissions when an operation exceeds host capabilities.

## Decision
When a request lacks required capability (e.g., `allowWrite: false`, denied path, or unsupported OS containment), `ms` immediately returns `E_POLICY_DENIED` or `E_UNSUPPORTED`. Approval workflows belong in the host/orchestrator.

## Consequences
- Predictable, fail-closed headless behavior suitable for automated agents and CI.
