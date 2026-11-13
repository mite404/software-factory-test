# v1-ticket8

## Status

- Goal: enforce one active orchestrator across separate orbs for a project.
- Initial priority: P0. Effort: Medium. Risk: elevated; split ownership duplicates side effects.
- Depends on: v1-ticket7.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F06. Local only; pending restore acceptance.

## Why this matters

SQLite's local writer lock cannot exclude another orchestrator in a different orb.

## Current state

Native durable ownership and serialized local actions exist. No cross-orb exclusive ownership
contract is implemented. A rejected backup push alone does not fence dispatch.

## Approach

Define an authoritative ownership claim with a generation that every side-effecting coordinator
operation verifies. Use supported shared infrastructure only after read-only capability discovery.
If no existing atomic claim capability is available, return a concrete provisioning blocker rather
than substituting an orb-local lock. Recovery requires explicit owner transfer and reconciliation.

## Scope

Include claim, fencing, relinquishment, recovery, and refusal without authority. Exclude
provisioning shared infrastructure, guessed expiry-based takeover, remote permission grants, and
worker deletion.

## Steps

1. **Discover atomic ownership authority**. Establish a supported compare-and-set or equivalent
   claim.
2. **Fence every coordinator action**. Reject stale owners before dispatch, messages, and snapshots.
3. **Prove replacement ownership recovery**. Reconcile old pending effects before explicit transfer.

## Test plan

Run competing coordinator processes over separate local databases using the real selected claim
mechanism or an explicitly labeled contract fixture. Pause the old owner across takeover and prove
it cannot act after resuming. Fail authority access and verify fail-closed behavior.

## Why this approach?

Ownership must fence side effects, not merely detect conflicting backups after duplicate dispatch.

## Files You'll Touch

| Path                                     | Role            | Contains                                    | Edit or Read        |
| ---------------------------------------- | --------------- | ------------------------------------------- | ------------------- |
| `factory/native.ts`, `factory/plugin.ts` | Coordinator     | Side-effect entry points                    | Edit                |
| `factory/persistence.ts`                 | Durable state   | Ownership generation                        | Edit                |
| `factory/backup.ts`                      | Snapshot writer | Authority checks                            | Edit after adoption |
| `factory/*.test.ts`                      | Proof           | Concurrent owners and stale generation      | Edit                |
| `factory/README.md`                      | Operations      | Explicit transfer and unavailable authority | Edit                |

Choose the claim boundary before adding consumers. Do not create infrastructure implicitly.

## Initial state / preflight

Run common preflight from `docs/v1-execution.md`; capability discovery is still pending.

| Command                                     | Expected result / action                      |
| ------------------------------------------- | --------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm restore and action entry points.      |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate current single-writer assumptions. |

## Done when

- [ ] Two orchestrators cannot act concurrently; old generations remain fenced after resume.
- [ ] Missing authority blocks actions without deleting retained work or granting permission.
- [ ] Gates and cold review pass; unavailable live infrastructure is reported as blocked proof.
