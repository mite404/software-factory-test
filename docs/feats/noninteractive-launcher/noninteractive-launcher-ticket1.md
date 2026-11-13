# noninteractive-launcher-ticket1

## Status

- Goal: run declared setup and gates without inheriting interactive shell startup behavior.
- Initial priority: P0
- Effort: Small
- Risk: shared subprocess launch and setup crash barrier.
- Depends on: F14 exact-worktree preparation.
- Planned at: `207f511c2d143b47efef8a158e452e67f860f6c4`, `2026-11-13`.
- Mode: local-only.

## Why this matters

Declared setup must work without repository-specific redirections or disabled lifecycle scripts.

## Current state

`verify` in `factory/native.ts` gives subprocesses piped stdin. Bun implements that stdin with a
socket. Nested Bash in this orb reads `.bashrc` and overwrites dependency paths. The native frozen
install failed twice with `lefthook: command not found`, while direct installation passed.
The same subprocess command passes with ignored stdin or command redirection to `/dev/null`.
The dogfood configuration temporarily redirects stdin without disabling hooks or gates.

## Approach

Give noninteractive commands deterministic stdin. Preserve the durable setup PID barrier before
execution. Fix the existing shared launcher, not package scripts or the orb's shell configuration.

## Scope

Factory launcher, behavioral regression and operator documentation only. Preserve timeouts,
process-group cancellation, bounded logs, failure retention and same-worktree recovery.
Do not edit coordinator queue, configuration, permissions, runtime state or frontend files.

## Steps

1. Reproduce startup interference through the public factory API with controlled shell fixtures.
2. Correct stdin ownership without removing the setup PID commit barrier.
3. Verify setup and gates, including interrupted setup and retry, then submit for cold review.

## Test plan

Use a temporary HOME and a harmless startup marker, never actual secret files. Prove an unchanged
launcher fails with nested shell dependency lookup and that the fix passes. Retain existing crash,
timeout and escaped-descendant tests. Run all gates and guard on the exact candidate.

## Why this approach?

The shared launcher owns command stdin. Patching each package script leaves every other nested
shell exposed. Redirecting only after the setup barrier preserves crash-safe preparation.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/native.ts` | Execution boundary | Setup and verification subprocesses | Edit |
| `factory/native.test.ts` | Behavioral proof | Setup lifecycle and real Git fixtures | Edit |
| `factory/README.md` | Operator contract | Declared command behavior | Edit |
| `factory/plugin.test.ts` | Adapter exemplar | Explicit preparation recovery | Read |

Build order: failing API proof, shared launcher, documentation.

## Initial state / preflight

Revalidate drift from the planning revision, including accepted escalation changes. Baseline gates
must be run in the assigned prepared worktree; this ticket does not claim they already passed.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record actual dispatch revision and explain drift. |
| `git status --short` | Preserve unrelated edits; implementation starts clean. |
| `git diff --stat 207f511c2d143b47efef8a158e452e67f860f6c4..HEAD -- factory/` | Review drift. |
| `git diff -- factory/; git diff --cached -- factory/` | Account for all implementation edits. |
| `bun --version` | Compare installed runtime with package manager declaration. |
| `bun run test && bun run lint:ci && bun run typecheck` | Retain full baseline output. |
| `bun run format:check && bun run fallow:ci` | No weakened checks. |
| `bash factory/checks.sh guard && git diff --check` | Guard and whitespace checks pass. |

## Done when

- [ ] Native setup succeeds with ordinary declared commands and no stdin workaround in config.
- [ ] Verification also preserves nested dependency lookup without relying on ancestor tools.
- [ ] Interrupted setup, timeout and explicit same-worktree retry retain their existing behavior.
- [ ] Exact committed candidate passes full gates and native conditional cold review.

## Notes

Real setup failure logs are retained in the dogfood Git factory directory. This is a product
regression, not an intentional reconnection TEST and not permission to edit the orb's shell files.
