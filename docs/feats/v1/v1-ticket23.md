# v1-ticket23

## Status

- Goal: expose recorded lifecycle facts and missed-poll replay without private report leakage.
- Initial priority: P0. Effort: Medium. Risk: elevated; inferred stages can falsely imply
  acceptance.
- Depends on: v1-ticket1, v1-ticket4, planned-intake-ticket1 and foreman-watchdog-ticket2.
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

Keep the implementation worker identity separate from the current reviewer identity, so landed
ticket links open the thread that built the candidate. Authored steps alone do not prove current
step progress; leave that unknown unless a producer records it.

Consume the planning/admission contract accepted in planned-intake-ticket1. That core ticket owns
SQLite planned records, canonical dispatch IDs, public outcomes and explicit Foreman promotion. This
ticket extends its projection without adding another admission path or parsing Markdown. Public
outcomes must not fall back to worker briefs. Backup identity is backup-adoption-ticket1.

Expose the durable run attempt on every task throughout build, review, repair, block, and
acceptance. Use an explicit unknown/not-started representation when no attempt exists; do not infer
attempt one. Expose a separate waiting-for-Foreman marker at the two-rejection checkpoint. It must
survive stale activity and distinguish that checkpoint from an ordinary block or review-thread
creation. Project accepted watchdog incident identity, curated reason kind, stall timing and nudge
count. Do not infer a checkpoint from even attempt numbers or implement notification policy in
reads.

## Scope

Include lifecycle projection and event replay from accepted private evidence. Exclude new gate or
review execution, raw private findings/reasons, frontend changes, and inference from motion.
Scheduled full-gate execution remains F15; expose its records only once that producer is accepted.
Admission and watchdog producers stay with their prerequisite tickets. No new scheduler or second
backlog store; preserve all dispatch permission checks.

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

Live v1-ticket1 polling on 2026-11-13 exposed a report-to-review gap: stale observations produced
`unknown`, then `blocked`, before review appeared as working. Reproduce this boundary with a slow
review-thread creation and prove the durable gate/review stage does not become a false failure.
Verify the builder link remains unchanged when the active thread becomes the reviewer.

Live backup adoption rejection appeared as blocked for only one two-second sample, then returned to
working with its previous revision and evidence erased. A five-second reader missed it. Test that
replay retains the rejection and attempt increment even after repair begins. Pending review creation
is not rejection; a disappearing review record is not an authoritative rejection event.

Consume planned-intake's tested records and prove counts and canonical IDs remain consistent with
its admission contract. Exercise attempts one through three and the two-reject checkpoint; attempt
and waiting-for-Foreman facts must survive review removal and missing heartbeat. A stalled incident
remains visible when diagnostic or unrelated events arrive; feed reads never send nudges or alerts.

## Why this approach?

Durable transitions describe what happened; a current heartbeat cannot reconstruct missed events.

## Files You'll Touch

| Path                                                    | Role           | Contains                                | Edit or Read   |
| ------------------------------------------------------- | -------------- | --------------------------------------- | -------------- |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Reads          | Evidence/events projection              | Edit           |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Public API     | Lifecycle fields and replay             | Edit           |
| `factory/native.ts`, `factory/plugin.ts`                | Producers      | Record missing explicit decisions       | Edit if needed |
| `factory/native.test.ts`, `factory/plugin.test.ts`      | Contract proof | Accepted producer compatibility         | Edit if needed |
| `factory/README.md`                                     | Contract       | Exact field names and unknown semantics | Edit           |

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
- [ ] Planned units and counts preserve the accepted admission contract and canonical dispatch IDs.
- [ ] Attempt and Foreman-checkpoint markers remain durable across review, repair, and stale
      activity.
- [ ] Watchdog incident, stall and nudge fields reflect accepted producers without read side
      effects.
- [ ] Full gates and cold review pass; frontend receives exact tested field names and examples.
