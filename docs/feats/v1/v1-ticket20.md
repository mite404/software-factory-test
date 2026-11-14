# v1-ticket20

## Status

- Goal: retain authorized Amp usage observations without double-counting or invented spending.
- Initial priority: P1. Effort: Medium. Risk: elevated; lifetime totals are not period expenditure.
- Depends on: v1-ticket2 and v1-ticket18.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F13. Local only; no broad account usage collection implicitly authorized.

## Why this matters

Retries and failed work cost money even when they never produce an accepted delivery.

## Current state

The factory does not ingest usage. PRD R16 specifies the supported Amp thread usage API and its
retention/total semantics; these facts must be rechecked against current primary documentation.

## Approach

Import authorized server-side cumulative observations once per thread/time/source. Compute period
deltas only from observed boundaries. Preserve missing data, shared coordinator overhead, failed
work, child attribution, provider breakdown, and separate optional BYOK estimates.

## Scope

Include ingestion, retained observations, and deterministic cost reports. Exclude UI scraping,
credential exposure, list-price invention, historical interpolation, and automatic paid evaluation.

## Steps

1. **Confirm supported usage semantics**. Read current API contract and authorization boundaries.
2. **Retain cumulative thread observations**. Deduplicate each worker and retry thread without
   subtotals.
3. **Report covered period deltas**. Mark partial periods and missing attribution explicitly.

## Test plan

Use fixed API fixtures with parent and child totals, repeated imports, out-of-order samples, missing
period boundaries, expired records, included subtotals, failed work, and unknown provider costs.
Derive totals independently. Reads must neither ingest nor call models.

## Why this approach?

Cumulative observations preserve what the API actually reported instead of fabricating past spend.

## Files You'll Touch

| Path                                                    | Role         | Contains                                  | Edit or Read |
| ------------------------------------------------------- | ------------ | ----------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Storage      | Authorized observations                   | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | API boundary | Supported server-side imports             | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Reports      | Coverage and period totals                | Edit         |
| `factory/README.md`                                     | Semantics    | Retention, attribution, and missing costs | Edit         |

Inspect current usage API before selecting source fields or adding an adapter module.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`. No usage collection ran while authoring.

| Command                                     | Expected result / action                         |
| ------------------------------------------- | ------------------------------------------------ |
| `git rev-parse HEAD`                        | Record accepted report and definition contracts. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect durable report identity changes.         |

## Done when

- [ ] Duplicate observations and included subtotals cannot double-count spending.
- [ ] Period, attribution, failed work, Amp usage, and BYOK estimates remain distinct.
- [ ] Full gates and cold review pass; unavailable live access stays visibly unverified.
