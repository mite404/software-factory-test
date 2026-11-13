# v1-ticket23

## Status

- Goal: expose recorded lifecycle facts and missed-poll replay without private report leakage.
- Initial priority: P0. Effort: Medium. Risk: elevated; inferred stages can falsely imply
  acceptance.
- Depends on: v1-ticket1 and v1-ticket4.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F07. Local only; pending evidence identity acceptance.

## Why this matters

The frontend currently infers stages from status and revision references. It cannot honestly show
per-check results, review decisions, blocked attempts, report delivery, or missed transitions.

## Current state

SQLite retains state and events. HTTP returns status, revision, and curated acceptance/review
references, but no public event cursor or explicit recorded skip decision.

## Approach

Project durable lifecycle stages, attempts, curated blocker ownership, report receipt and escalation
references, per-check outcomes, and review decision references. Use explicit recorded skip reasons;
legacy absence remains unknown. Add bounded timestamped event replay with stable ordering/cursors.
Keep activity freshness separate from the last committed lifecycle stage.

## Scope

Include lifecycle projection and event replay from accepted private evidence. Exclude new gate or
review execution, raw private findings/reasons, frontend changes, and inference from motion.
Scheduled full-gate execution remains F15; expose its records only once that producer is accepted.

## Steps

1. **Project recorded lifecycle facts**. Separate stage, activity, attempt, blockers, and
   acceptance.
2. **Expose bounded event replay**. Use stable identities and cursors across equal
   timestamps/restart.
3. **Verify decision and privacy**. Distinguish recorded skips from unknown legacy review evidence.

## Test plan

Drive real HTTP/SQLite through queued, building, gate, review, repair, escalation, and accepted
states. Poll slowly across several transitions and replay exactly once. Seed private canaries in
reports and raw blocked reasons. Invalid cursors and missing records return curated errors. No read
may wake a model, rerun a gate, or mutate durable state.

## Why this approach?

Durable transitions describe what happened; a current heartbeat cannot reconstruct missed events.

## Files You'll Touch

| Path                                                    | Role       | Contains                                | Edit or Read   |
| ------------------------------------------------------- | ---------- | --------------------------------------- | -------------- |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Reads      | Evidence/events projection              | Edit           |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Public API | Lifecycle fields and replay             | Edit           |
| `factory/native.ts`, `factory/plugin.ts`                | Producers  | Record missing explicit decisions       | Edit if needed |
| `factory/README.md`                                     | Contract   | Exact field names and unknown semantics | Edit           |

Inspect accepted evidence records before declaring fields. Publish a tested example to frontend.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`; richer-feed checks have not run during authoring.

| Command                                     | Expected result / action                           |
| ------------------------------------------- | -------------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm accepted evidence and title prerequisites. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate producer and projection contracts.      |

## Done when

- [ ] Explicit stage/decision/attempt facts remain distinct from unknown or stale observations.
- [ ] Bounded replay preserves all ordered events without private report disclosure or model calls.
- [ ] Full gates and cold review pass; frontend receives exact tested field names and examples.
