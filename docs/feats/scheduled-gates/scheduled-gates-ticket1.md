# scheduled-gates-ticket1

## Status

- Goal: distinguish local landing from a scheduled full-gate result for the exact revision.
- Initial priority: P0
- Effort: Large
- Risk: elevated; stale or absent proof must never release dependents or imply full verification.
- Depends on: native persistence and serialized landing; F12 effective gate configuration.
- Planned at: `7a3b1c6c705c0c54bc08b5f7734fd3ffb78de608`, 2026-11-13.
- Local path: `docs/feats/scheduled-gates/scheduled-gates-ticket1.md`
- Backlog: F15. Local-only draft; implementation not started.

## Why this matters

The PRD's target workflow has a scheduled full gate after landing. The native slice instead runs one
configured full command before acceptance. A landed revision cannot silently become verified.

## Current state

`checkCandidate` and `accept` in `factory/native.ts` bind proof to a candidate and current base.
`Run` in `factory/persistence.ts` has a single done outcome. `factory/checks.sh full` already owns
the project's full command. There is no persisted scheduled full-gate lifecycle.

## Approach

Keep the current conservative full-before-acceptance policy as the default. Add an explicit project
policy for trusted landing checks and scheduled full checks. Persist landed and fully verified
revisions separately. The coordinator executes bounded checks without a model or another CI watcher.

## Scope

- In: durable gate attempts, due-work reconciliation, revision binding, and owned repair outcomes.
- Out: automatic bisection, batching, remote publication, and implicit schedule enablement.
- Expected edit boundary: `factory/`; revalidate the F12 definition boundary before dispatch.

## Steps

1. **Define distinct gate outcomes**. Model landed, pending, passed, failed, interrupted, and stale.
2. **Persist serialized check attempts**. Record exact revision, base, command version, result, and log
   reference.
3. **Retain original repair ownership**. Withhold dependent acceptance until required
   proof.
4. **Expose truthful gate status**. Document opt-in policy and explicit scheduling permissions.

## Test plan

- Land through a declared fast lane; assert it is not reported fully verified.
- Advance integration after a gate starts; its result must not verify the newer revision.
- Deliver concurrent wake-ups and restart during execution; no overlapping or invented pass occurs.
- Fail a full gate, route the culprit revision to its original owner, and verify the repaired head.
- Keep default full-before-acceptance behavior and all existing rejection/review tests passing.
- Run due checks in a disposable real Git repository, not only a mocked command runner.

## Why this approach?

A separate scheduler or a Boolean done flag would lose the distinction between landed and checked.
Persisting exact gate attempts inside the coordinator preserves ownership and restart evidence.

## Files You'll Touch

| Path                          | Role              | Contains                                   | Edit or Read |
| ----------------------------- | ----------------- | ------------------------------------------ | ------------ |
| `factory/persistence.ts`      | Durable boundary  | Landings and gate attempts                 | Edit         |
| `factory/native.ts`           | Lifecycle         | Due checks and original-owner repairs      | Edit         |
| `factory/plugin.ts`           | Native adapter    | Wake-up and truthful observations          | Edit         |
| `factory/dashboard.ts`        | Public projection | Curated verification state                 | Edit         |
| `factory/native.test.ts`      | Behavioral proof  | Revision, failure, concurrency and restart | Edit         |
| `factory/persistence.test.ts` | Storage proof     | Durable attempts and migration             | Edit         |
| `factory/dashboard.test.ts`   | Projection proof  | Landed versus fully verified               | Edit         |
| `factory/checks.sh`           | Existing gate     | Full and landing commands                  | Read         |
| `factory/README.md`           | Operator contract | Policy, scheduling and recovery            | Edit         |

Build persistence before reconciliation, then adapter and projection. Read the accepted F12
definition implementation before editing configuration; do not invent a second authored format.

## Initial state / preflight

Not run for this draft. Re-scope against the accepted F12 revision before dispatch.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record dispatch SHA and accepted prerequisites.       |
| `git status --short`                        | Preserve known edits; require a clean candidate base. |
| `git diff --stat 7a3b1c6..HEAD -- factory/` | Inspect prerequisite drift.                           |
| `git diff -- factory/`                      | No unexplained unstaged changes.                      |
| `git diff --cached -- factory/`             | No unexplained staged changes.                        |
| `bun --version`                             | Record tool version.                                  |
| `bun install --frozen-lockfile`             | Exact-worktree dependencies prepared.                 |
| `bash factory/checks.sh full`               | All configured baseline gates pass.                   |
| `git diff --check`                          | No whitespace errors.                                 |

## Done when

- [ ] Landing alone is not full verification; the default remains conservative.
- [ ] Full gates bind to exact revisions and survive duplicate wake-ups and restart safely.
- [ ] Failures preserve culprit evidence and original repair ownership.
- [ ] The complete gate and required independent cold review pass for the implementation candidate.
