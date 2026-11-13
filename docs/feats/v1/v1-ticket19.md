# v1-ticket19

## Status

- Goal: retain multidimensional versioned delivery and suite scorecards from actual evidence.
- Initial priority: P1. Effort: Medium. Risk: elevated; advisory scores cannot override failed
  gates.
- Depends on: v1-ticket11 and v1-ticket18.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F13. Local only; pending verification and reporting acceptance.

## Why this matters

Test counts and a single factory score would hide missing requirement coverage or reproduced
failures.

## Current state

No scorecard persistence or scorer declaration exists. R16 requires versioned source evidence and
separation of deterministic results from optional advisory model judgments.

## Approach

Use accepted definition scorer declarations and evidence records. Store fixture/suite/rubric/tool
versions, candidate revision, dimensions, counts, and failures. Keep incompatible versions separate.
Any optional model evaluator requires explicit authorization and records its own cost and version.

## Scope

Include deterministic scorecard storage and reads. Exclude automatic model evaluations, one-number
rankings, test-count effectiveness claims, and changing acceptance or execution policy.

## Steps

1. **Define versioned scorecard dimensions**. Bind declared coverage and failures to exact
   artifacts.
2. **Store evaluator provenance separately**. Mark advisory judgments without changing mandatory
   gates.
3. **Reject incompatible score comparisons**. Preserve old rubrics and unknown instability evidence.

## Test plan

Compare changed rubric versions, a high advisory score with a mandatory failure, identical test
counts with different reproduced failures, and duplicate imports. Report observed instability
without asserting flakiness absent repeated evidence. Reads execute no evaluation or CI rerun.

## Why this approach?

Separate dimensions let the operator inspect why a delivery passed instead of trusting an average.

## Files You'll Touch

| Path                                                    | Role           | Contains                     | Edit or Read          |
| ------------------------------------------------------- | -------------- | ---------------------------- | --------------------- |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Storage        | Scorecards and provenance    | Edit                  |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Reads          | Versioned dimensions         | Edit                  |
| Accepted definition schema                              | Declarations   | Supported scorer settings    | Edit after inspection |
| `factory/README.md`                                     | Interpretation | Coverage and advisory limits | Edit                  |

Resolve authoritative schema paths after v1-ticket11, not during this draft.

## Initial state / preflight

Execute common preflight in `docs/v1-execution.md`; no evaluator execution is authorized here.

| Command                                     | Expected result / action                          |
| ------------------------------------------- | ------------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm accepted capability and metric contracts. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate evidence identities.                   |

## Done when

- [ ] Versioned dimensions retain counts, failures, and provenance without false comparisons.
- [ ] Advisory results cannot override mandatory gates; reads perform no evaluations.
- [ ] Full gates and cold review pass.
