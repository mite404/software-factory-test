# v1-ticket7

## Status

- Goal: restore a validated project snapshot before replacement dispatch.
- Initial priority: P0. Effort: Medium. Risk: elevated; wrong restore can erase history or duplicate
  work.
- Depends on: v1-ticket6.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F06. Local only; pending complete snapshot acceptance.

## Why this matters

An orb-local SQLite database is not a replacement-orb recovery mechanism.

## Current state

`openPersistence` can open or migrate local state; there is no replacement restore workflow.

## Approach

Fetch the latest confirmed project's snapshot through a deterministic explicit restore operation.
Validate identity, schema, integrity, artifacts, and source revisions before atomic installation.
Distinguish explicit initialization from startup with missing expected state. Reconcile retained
worker ownership and uncertain actions before allowing execution.

## Scope

Include restore validation and dispatch blocking. Exclude ownership takeover policy, automatic
worker recreation, newer-local-state overwrite, real remote provisioning, and resource cleanup.

## Steps

1. **Validate recovered snapshot identity**. Reject wrong project, incompatible schema, and
   corruption.
2. **Restore without erasing history**. Preserve newer local state and explicit initialization
   intent.
3. **Reconcile retained worker ownership**. Missing worktrees block rather than replace owners.

## Test plan

Restore from a disposable local remote into a second clean repo. Fail access, omit artifacts, change
project identity, corrupt data, and provide a newer local DB. Interrupt installation and retry.
Confirm no dispatch or uncertain remote replay occurs before reconciliation.

## Why this approach?

Validation before installation prevents a failed restore from turning into an empty new project.

## Files You'll Touch

| Path                                                    | Role              | Contains                           | Edit or Read        |
| ------------------------------------------------------- | ----------------- | ---------------------------------- | ------------------- |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Storage           | Validated restore boundary         | Edit                |
| `factory/native.ts`, `factory/native.test.ts`           | Startup           | Reconciliation blockers            | Edit                |
| `factory/setup-factory.ts`                              | Setup             | Explicit initialize versus restore | Edit                |
| `factory/backup.ts`                                     | Snapshot contract | Accepted manifest and receipts     | Read after adoption |
| `factory/README.md`                                     | Recovery guide    | Restore and refusal paths          | Edit                |

Inspect accepted snapshot formats before selecting restore module paths.

## Initial state / preflight

Execute common preflight in `docs/v1-execution.md`. No restore trial ran during authoring.

| Command                                     | Expected result / action                      |
| ------------------------------------------- | --------------------------------------------- |
| `git rev-parse HEAD`                        | Identify accepted complete-snapshot revision. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate startup and storage behavior.      |

## Done when

- [ ] Valid snapshots restore without owner duplication; invalid or missing data blocks startup.
- [ ] Newer local state and ambiguous external actions remain preserved.
- [ ] Full gates and cold review pass; true replacement-orb proof remains tracked by v1-ticket22.
