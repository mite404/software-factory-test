# F032-landing-per-commit-proof

## Status

- Goal: `record-landing` and `record-merge` accept a landing whose accepted change is several
  commits, when every one of those commits landed upstream.
- Outcome: A multi-commit candidate can record its landing
- Initial priority: P1. Effort: Small.
- Risk: elevated; this is the proof that accepted code reached the target branch. Loosening it
  wrongly would mark unlanded code as done.
- Depends on: F031-landing-without-checkpoint (done).
- Planned at: `04e1eadc53b8dab47ef141500aaf1e998e350789`, 2026-11-16. Local only.

## Why this matters

F005's accepted candidate `8cacf3d` is two commits over base `9a7eb78`: `e86be2a` and `8cacf3d`.
PR #56 landed both as `2dbf169` and `494d809`, and each pair has the same `git patch-id --stable`.
`record-landing` still refuses with "Merge commit does not contain the accepted change", so F005
stays blocked and F007 cannot dispatch. Any candidate that a same-worker repair stacks on an
earlier commit lands the same way and hits the same refusal.

## Current state

- `verifyMerge` in `factory/native.ts` builds one patch-id from the whole `base..revision` diff
  and looks for a single no-merge commit in `base..commit` with that patch-id.
- Both `verifiedLanding` (`record-landing`) and the `record-merge` action call `verifyMerge`.
- The upstream, ancestry and accepted-revision checks before the patch comparison are correct.

## Approach

- Keep the combined-diff match as one way to pass, so a squashed landing still verifies.
- Add the other way: every no-merge commit in `base..revision` has a commit in `base..commit`
  with the same patch-id, like `git cherry`. An empty-diff commit on either side never counts as
  a match.
- Everything else in `verifyMerge` stays: upstream must be a fetched remote, the merge commit
  must be in upstream, and the accepted revision must be a full SHA.

## Scope

- In: the patch comparison in `verifyMerge`, tests, and a README note.
- Out: the identity checks in `verifiedLanding`, `record-merge` request parsing, and any new
  action.
- Preserve: single-commit and squashed landings verify exactly as before.

## Steps

1. **Match commits one by one**. In `verifyMerge`, also accept the landing when each no-merge
   commit in the accepted range has a patch-id twin among the landed commits.
2. **Keep the squash path**. Leave the combined-diff match in place so a squash merge still
   verifies, and keep every upstream and ancestry check before it.
3. **Document the proof**. Say in `factory/README.md` how `record-landing` and `record-merge`
   prove that the accepted change landed.

## Test plan

- A two-commit candidate landed as two cherry-picked commits records through both
  `record-landing` and `record-merge`.
- The same candidate squashed into one commit still records.
- Refusals change nothing: only one of the two commits landed; a landed commit differs by one
  line; an accepted range with an empty commit whose other commit did not land.
- A single-commit candidate behaves as before.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: any multi-commit candidate that lands as separate commits can never be recorded,
  and the ticket and everything after it stay blocked.
- This buys: each accepted commit must have an exact landed twin, so the proof stays as strict
  per change as today while matching how cherry-picked landings actually look.

## Files You'll Touch

| Path                     | Role              | Contains                         | Edit or Read |
| ------------------------ | ----------------- | -------------------------------- | ------------ |
| `factory/native.ts`      | Lifecycle         | `verifyMerge`, `patchID`         | Edit         |
| `factory/native.test.ts` | Lifecycle proof   | Landing and merge record fixture | Edit         |
| `factory/README.md`      | Operator contract | Recovery and merge recording     | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                                         | Expected result / action                              |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                                            | Record it; explain differences from the planning SHA. |
| `git status --short`                                            | Clean, or every edit accounted for.                   |
| `rg -n "function verifyMerge\|verifyMerge\(" factory/native.ts` | Revalidate the proof and its two callers.             |
| `bun test factory`                                              | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`                          | No errors.                                            |
| `bun run format:check && bun run fallow:ci`                     | Pass.                                                 |
| `bash factory/checks.sh guard`                                  | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] A multi-commit candidate landed as separate commits records through `record-landing` and
      `record-merge`.
- [ ] Squashed and single-commit landings verify as before.
- [ ] A partial or altered landing is refused and changes nothing.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
