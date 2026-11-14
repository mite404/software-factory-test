# v1-ticket6

## Status

- Goal: include required evidence and lessons in acknowledged phase snapshots.
- Initial priority: P0. Effort: Medium. Risk: elevated; incomplete backups could permit data loss.
- Depends on: canonical Feature 05, v1-ticket5.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F05. Local only; backup adoption is merged, evidence and lessons remain prerequisites.

## Why this matters

The preserved backup slice explicitly excludes evidence outside SQLite and is insufficient for
restoration and safe worker retirement.

## Current state

The adopted Feature 05 command snapshots SQLite and a manifest and is merged through PR #3.
Evidence layout will be defined by v1-ticket4; do not guess file names before that lands.

## Approach

Extend the shared backup operation to preserve declared required evidence and lesson outcomes.
Trigger authorized phase checkpoints through that same operation. Bind receipts to a manifest and
source revisions, preserving the last confirmed snapshot when later local progress exists.

## Scope

Include consistent evidence snapshots, checkpoint requests, and receipt coverage. Exclude real
remote creation/push, restore, retirement, retention deletion, and arbitrary file copy.

## Steps

1. **Declare required snapshot contents**. Enumerate private evidence and lessons by stable
   identity.
2. **Snapshot phase outcomes consistently**. Serialize checkpoint and manual backup requests.
3. **Confirm exact preservation coverage**. Distinguish local progress from remotely confirmed data.

## Test plan

Use SQLite writes during snapshot and a real local bare remote. Verify two isolated project keys,
missing evidence refusal, unchanged no-op, lost push acknowledgment, restart, and failed
confirmation. Inspect public Git history and canary credentials for exclusion. No live push is
authorized.

## Why this approach?

A backup receipt must prove the accepted outcome's artifacts, not merely that some database moved.

## Files You'll Touch

| Path                                          | Role              | Contains                        | Edit or Read        |
| --------------------------------------------- | ----------------- | ------------------------------- | ------------------- |
| `factory/backup.ts`, `factory/backup.test.ts` | Adopted backup    | Accepted command paths          | Edit                |
| `factory/persistence.ts`                      | Private records   | Evidence and lessons            | Read                |
| `factory/native.ts`, `factory/plugin.ts`      | Checkpoints       | Authorized requests             | Edit                |
| `factory/README.md`                           | Operator contract | Coverage and last confirmation  | Edit                |

Verify evidence enumeration before changing snapshot publication.

## Initial state / preflight

Run shared preflight in `docs/v1-execution.md`. No snapshot coverage checks ran at authoring.

| Command                                     | Expected result / action                         |
| ------------------------------------------- | ------------------------------------------------ |
| `git rev-parse HEAD`                        | Confirm backup and lesson prerequisites.         |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect adopted snapshot and evidence contracts. |

## Done when

- [ ] Confirmed snapshots contain required accepted evidence and lessons, without credentials.
- [ ] Duplicate checkpoints and uncertain pushes do not duplicate publication or erase receipts.
- [ ] Full gates and cold review pass; live remote proof remains explicitly permission-limited.
