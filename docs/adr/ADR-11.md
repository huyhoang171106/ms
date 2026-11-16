# ADR-11: `ms exec` Guard, Credential Scrub and Typo Auto-Correct

**Status:** Accepted

## Context
`ms exec` is the drop-in replacement for a coding agent's own `run_command` tool. Measured against the
harness baseline (`axiom-cli/src/tools/bash.ts`), `ms exec` was faster to read but weaker to trust: it had
no destructive-command guard, passed the agent's whole environment (including API keys) to the child, used a
60 s default timeout, and failed on a one-character typo in the binary name where the baseline at least ran
the command. Distillation and the persisted raw log were already strictly better (`cargo test --workspace`:
5221 B/115 lines raw → 138 B/2 lines distilled, full log retrievable via `ms log`).

## Decision
1. **Guard before spawn.** `destructive_reason` normalises quoting, `//`, `/./`, `/../` and `$HOME`, then
   parses each segment for recursive `rm` at `/`/`~`/home, block-device writes, shutdown/reboot, `kill -1`,
   and fork bombs. The decision is split into `guard()` so it is unit-testable **without spawning anything**.
   It is defence in depth, not the security boundary (that stays the workspace sandbox).
2. **Scrub credential env by default.** Names matching `KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE`
   are dropped, `PATH/HOME/LANG/TERM` always survive. `--keep-env` / MCP `keepEnv` opts out for builds that
   legitimately need a token (git over ssh, `gh`, private registries).
3. **Auto-correct one-typo binaries.** If the leading binary does not resolve on `PATH` but exactly one
   executable there is one edit away, it is substituted and reported as `[autocorrect] carog -> cargo`.
   Explicit paths, `VAR=value` assignments, shell builtins and ambiguous matches are never rewritten.
4. **Parity defaults.** 120 s timeout (was 60 s) in both CLI and MCP.

## Consequences
- An agent gets the baseline tool's safety properties plus distillation, a durable log, and typo recovery
  instead of a wasted round-trip on `cargo` mistyped as `carog`.
- Auto-correct can pick a wrong-but-nearby binary; the `[autocorrect]` line keeps it visible and the rule
  only fires when exactly one candidate exists.
- Scrubbing by default will break a command that truly needs a credential in its environment; `--keep-env`
  is the documented escape hatch.
- Cost stays negligible: `ms exec -- true` is ~3.9 ms wall against `bash -c true` at ~1.2 ms, and the
  retention sweep now runs at most every 5 minutes instead of on every invocation.
