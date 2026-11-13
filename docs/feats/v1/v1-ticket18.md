# v1-ticket18

## Status

- Goal: calculate revision-bound delivery reliability and workflow delay from recorded evidence.
- Initial priority: P1. Effort: Medium. Risk: elevated; bad cohorts can turn missing evidence green.
- Depends on: scheduled-gates-ticket1, remote-monitoring-ticket1, and v1-ticket4.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F13. Local only; pending evidence producers.

## Why this matters

Thread counts and eventual green CI do not measure first-pass delivery reliability.

## Current state

Native state records acceptance and retries. Delivery cohorts, CI outcome histories, and metric
definitions are not implemented. R16 defines formulas and explicit missing-data states.

## Approach

Read normalized delivery/check/event records. Preserve first failures across repairs, exact current
revision CI states, repair observation windows, blocked time, and unfinished age. Return numerator,
denominator, coverage, time basis, exclusions, freshness, and inspectable sources with each measure.

## Scope

Include deterministic reports and read-only API. Exclude charts, usage ingestion, invented CI,
automatic evaluations, model scores, and policy changes based on scores.

## Steps

1. **Normalize delivery outcome evidence**. Separate direct commits, PR outcomes, publication, and
   checks.
2. **Calculate explicit reliability cohorts**. Preserve first failures and label incomplete
   observations.
3. **Report delays with coverage**. Separate elapsed stage duration, unfinished age, and
   interventions.

## Test plan

Use asymmetric known timestamps and failed-then-green CI. Include absent/stale/cancelled checks,
direct commits, closed-unmerged PRs, duplicates, out-of-order attempts, and immature repair windows.
Expected numerators and durations come from fixture facts, not the implementation's calculations.

## Why this approach?

Source-bound cohorts make missing evidence visible instead of rewarding projects with fewer checks.

## Files You'll Touch

| Path                                                | Role           | Contains                           | Edit or Read     |
| --------------------------------------------------- | -------------- | ---------------------------------- | ---------------- |
| `factory/persistence.ts`                            | Source records | Accepted delivery and event schema | Read             |
| `factory/dashboard.ts`, `factory/dashboard.test.ts` | Report API     | Read-only projections              | Edit             |
| `factory/` proposed report module and tests         | Calculation    | R16 formulas and cohorts           | Create if needed |
| `factory/README.md`                                 | Definitions    | Cohorts, exclusions, and freshness | Edit             |

Normalize source identities before formulas. Do not infer active coding time from thread age.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`. Report tests are pending upstream producers.

| Command                                     | Expected result / action                           |
| ------------------------------------------- | -------------------------------------------------- |
| `git rev-parse HEAD`                        | Record accepted gate and monitoring schemas.       |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect event correlation and revision identities. |

## Done when

- [ ] First failure survives repair and unknown checks cannot inflate success rates.
- [ ] Cohorts, flow measures, and repair windows expose evidence and coverage without model calls.
- [ ] Full gates and required independent review pass.
