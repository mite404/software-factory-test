# v1-ticket17

## Status

- Goal: retire worker resources only after accepted code, evidence, and lessons are preserved.
- Initial priority: P0. Effort: Medium. Risk: elevated; premature cleanup destroys recoverable work.
- Depends on: v1-ticket5, v1-ticket6, v1-ticket8, and v1-ticket9.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F11. Local only; no real worker-orb deletion authorized.

## Why this matters

An idle worker or accepted commit does not prove that private evidence survived outside its orb.

## Current state

Implementation workers are retained unarchived. Retirement lifecycle and preservation checks do not
exist. Finished reviewers have been archived separately after evidence preservation.

## Approach

Record retirement separately from acceptance. Require integrated revision, preserved artifacts,
accepted lessons, and acknowledged snapshot coverage before any authorized resource operation. Use
supported idempotent cleanup adapters and retain implementation thread history.

## Scope

Include eligibility, durable requests, refusal, and adapter reconciliation. Exclude actual resource
deletion in this trial, automatic archival of implementation threads, and permission invention.

## Steps

1. **Verify retirement preservation prerequisites**. Bind every retained artifact to the accepted
   outcome.
2. **Record separate resource retirement**. Require explicit permission and reconcile uncertain
   effects.
3. **Prove cleanup refusal paths**. Reject stale proof, missing evidence, and unconfirmed snapshots.

## Test plan

Use disposable artifact directories and a controlled cleanup boundary. Repeat events, lose an
adapter response, fail backup, remove a preserved artifact, and retain a rejected candidate. Assert
no cleanup or replacement worker occurs on idle alone, and thread archival stays separate.

## Why this approach?

Acceptance records code quality; a preservation receipt is the fact that makes retirement safe.

## Files You'll Touch

| Path                                                    | Role         | Contains                         | Edit or Read      |
| ------------------------------------------------------- | ------------ | -------------------------------- | ----------------- |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle    | Eligibility and retention        | Edit              |
| `factory/persistence.ts`, `factory/persistence.test.ts` | History      | Retirement requests and outcomes | Edit              |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Adapter      | Supported resource operations    | Edit              |
| `factory/backup.ts`, `factory/README.md`                | Preservation | Snapshot coverage and contract   | Read or Edit docs |

Implement eligibility before side-effect adapters. Never delete a real worker to satisfy a test.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`. Native resource destruction remains unauthorized.

| Command                                     | Expected result / action                                 |
| ------------------------------------------- | -------------------------------------------------------- |
| `git rev-parse HEAD`                        | Verify complete preservation and transfer prerequisites. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect accepted ownership and evidence contracts.       |

## Done when

- [ ] Missing preservation or permission blocks cleanup without erasing work.
- [ ] Duplicate/uncertain actions reconcile once; implementation threads remain unarchived.
- [ ] Gates and cold review pass; live retirement is still a permission-limited acceptance item.
