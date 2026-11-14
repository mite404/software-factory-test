# v1-ticket21

## Status

- Goal: show evidence-based effectiveness and spending without misleading rankings.
- Initial priority: P1. Effort: Medium. Risk: elevated; missing evidence must remain visible.
- Depends on: v1-ticket13, v1-ticket19, and v1-ticket20.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F13. Local only; frontend scope needs existing-owner coordination.

## Why this matters

The operator needs inspectable reliability and repair evidence, not a busy-thread dashboard score.

## Current state

The independently developed workbench displays pipeline activity. Effectiveness source APIs and UI
have not been accepted. R16 defines required measures and exclusions.

## Approach

Extend the accepted workbench with reliability first, then delay, scorecard, and spending views.
Show cohort, numerator/denominator, sample count, evidence coverage, freshness, and source links.
Separate unknown/current CI states and partial periods from observed success and complete spend.

## Scope

Include read-only views of accepted report APIs. Exclude new evaluations, CI reruns, automatic
policy changes, unrelated redesign, and unsupported comparisons between configuration versions.

## Steps

1. **Present reliability with coverage**. Show first failures and unfinished work without green
   defaults.
2. **Expose score and spending sources**. Keep version, cohort, attribution, and exclusions visible.
3. **Verify missing evidence displays**. Exercise zero denominators and partial periods in browser.

## Test plan

Render absent CI, failed-then-green repair, direct commits, pending PRs, incompatible rubrics,
expired usage, and partial periods. Inspect narrow/wide screenshots, keyboard source inspection, and
reduced motion. Instrument reads to prove no model, evaluation, or CI rerun occurs.

## Why this approach?

Coverage next to the measure prevents an attractive number from hiding the evidence it excludes.

## Files You'll Touch

| Path                              | Role                    | Contains                  | Edit or Read                 |
| --------------------------------- | ----------------------- | ------------------------- | ---------------------------- |
| `web/` after frontend integration | Reports                 | Existing UI and tests     | Edit with owner coordination |
| `factory/dashboard.ts`            | Read API                | Accepted metric contracts | Read                         |
| `factory/README.md`               | Operator interpretation | Coverage and missing data | Edit                         |

Inspect accepted frontend and report shapes before naming components or chart dependencies.

## Initial state / preflight

Execute common preflight in `docs/v1-execution.md` and the integrated browser workflow. No report
rendering checks ran during authoring.

| Command              | Expected result / action                          |
| -------------------- | ------------------------------------------------- |
| `git rev-parse HEAD` | Record accepted reports and combined UI revision. |
| `git status --short` | Preserve frontend ownership and unrelated work.   |

## Done when

- [ ] Reports show evidence coverage, incomplete states, and versioned sources accurately.
- [ ] Reads remain model-free and all affected UI states pass inspected browser verification.
- [ ] Combined gates and required cold review pass.
