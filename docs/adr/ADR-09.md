# ADR-09: No Arbitrary External Process Execution Before K4

**Status:** Accepted

## Context
Command-name allowlists (`PolicyConfig`) without OS containment do not prevent interpreters or build tools from escaping the workspace, opening network connections, or reading `state_dir`.

## Decision
Arbitrary external process execution is disabled (`allowExternalExec: false`) in K1/K2. Builtins (`list`, `search`, `read`, `patch`) execute in-process via `WorkspaceFs` without shelling out. External execution is deferred to K4 with Linux OS containment (`bubblewrap`, cgroup v2, network namespace).

## Consequences
- Eliminates command-injection and shell-escape vectors in the MVP.
