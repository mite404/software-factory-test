# F030-record-external-landing

## Status

- Goal: the owning Foreman can record that a blocked ticket's candidate landed outside the
  factory, after Git proves that the candidate's change is on the upstream branch. The ticket then
  becomes done with its merge recorded, and its dependents can dispatch.
- Outcome: A ticket landed outside the factory counts as done
- Initial priority: P1. Effort: Small.
- Risk: elevated; this writes a done run without the native gate or review. It must accept only a
  candidate whose exact patch Git finds on the upstream branch, and only from the owner.
- Depends on: none.
- Planned at: `714de51a11e1a8265a5150fe3635a0641fb9e75b`, 2026-11-15. Local only.

## Why this matters

F004's candidate `3fe8f38` passed every check except `format:check`, which failed on a
clone-only file from the Foreman's base, outside the ticket's allowed paths. With operator
approval the Foreman cherry-picked it, ran a separate cold review and merged it as PR #51.
The factory still records F004 as `blocked`. `record-merge` refuses because the run is not
`done`, and `resume` only queues the same worker on the same base, which fails the same way.
F007 lists F004 in `after`, so F007 and the six tickets behind it can never dispatch. The watchdog
also keeps alerting on an incident that has nothing left to do.

## Current state

- `saveMerge` in `factory/native.ts` throws "Merge recording requires a done ticket" unless
  `state.runs[ticket].kind === "done"`, then calls `verifyMerge(root, run, commit)`.
- `verifyMerge` requires a fetched remote upstream, checks the merge commit is its ancestor, and
  matches the patch ID of `acceptedBase..revision` against upstream history.
- A worker-blocked run is `{ kind: "blocked", reason, checkpoint, incident }`; the candidate's
  revision is in the report file and the run's `checkpoint`, not in a done record.
- `dispatchNext` dispatches a ticket only when every `after` entry is `done`.
- `plugin.ts` exposes `record-merge` with `ticket`, `pr` and `commit`, owner only.

## Approach

- Add an owner-only `record-landing` action with `ticket`, `incident`, `revision`, `pr`, `commit`
  and `decision`. It accepts only a `blocked` run with no queued repair whose incident ID matches.
- Verify with the existing merge check: `revision` is the full SHA the worker reported for this
  run, the patch ID of `run.base..revision` is on the fetched upstream, and `commit` is an
  upstream ancestor. Any mismatch throws and changes nothing.
- On success, write a `done` run with `revision`, `acceptedBase: run.base`, the merge record and
  the decision as its insight. Commit one `landed-outside` event, which closes the incident.
- Repeat calls with the same evidence return the current state; conflicting evidence throws.

## Scope

- In: the action, its validation and persistence, the plugin parameter, tests, and README and
  `foreman.md` notes.
- Out: accepting code without upstream proof, recording for a running or uncertain run, and
  changing `record-merge`.
- Preserve: every existing state, action and saved record loads and behaves as before.

## Steps

1. **Accept landing requests**. Add `record-landing` to the plugin and native controls, owner
   only, requiring ticket, current incident ID, full revision, positive PR, full merge commit and
   a non-empty decision.
2. **Prove the landed patch**. Reuse `verifyMerge` so the run's base-to-revision patch and the
   merge commit must both be on the fetched upstream.
3. **Record the done run**. Replace the blocked run with a done run carrying revision, base,
   merge record and decision, and append one `landed-outside` event.
4. **Document the recovery**. Describe when the Foreman may use the action in the README and
   `foreman.md`.

## Test plan

- A blocked run whose patch is on the upstream branch becomes done with its merge recorded, and a
  dependent ticket then dispatches.
- Each rejection changes nothing: wrong incident ID, non-owner, running run, a repair queued, a
  revision whose patch is not upstream, and a merge commit that is not an upstream ancestor.
- The same request twice returns the same state; a different PR or commit throws.
- Saved state from before the change opens unchanged.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: a ticket landed by the operator stays blocked forever, its dependents never
  dispatch, and the only workaround is editing `after` or hand-editing private state.
- This buys: the done record is written only on Git proof of the exact candidate patch, through
  the same check `record-merge` already trusts, so the factory never accepts unproven code.

## Files You'll Touch

| Path                     | Role              | Contains                                | Edit or Read |
| ------------------------ | ----------------- | --------------------------------------- | ------------ |
| `factory/native.ts`      | Lifecycle         | `saveMerge`, `verifyMerge`, run records | Edit         |
| `factory/native.test.ts` | Lifecycle proof   | Landing, rejections, dependent dispatch | Edit         |
| `factory/plugin.ts`      | Control surface   | Actions and parameters                  | Edit         |
| `factory/plugin.test.ts` | Control proof     | Parameter validation, owner only        | Edit         |
| `factory/persistence.ts` | Records           | Run validators for the done record      | Read or Edit |
| `factory/README.md`      | Operator contract | Recovery actions                        | Edit         |
| `factory/foreman.md`     | Foreman guide     | When to record an outside landing       | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                                              | Expected result / action                              |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                                                 | Record it; explain differences from the planning SHA. |
| `git status --short`                                                 | Clean, or every edit accounted for.                   |
| `rg -n "function saveMerge\|function verifyMerge" factory/native.ts` | Revalidate the merge path.                            |
| `bun test factory`                                                   | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`                               | No errors.                                            |
| `bun run format:check && bun run fallow:ci`                          | Pass.                                                 |
| `bash factory/checks.sh guard`                                       | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [x] The owner can record a blocked ticket as landed only with Git proof of its exact patch.
- [x] Every rejected request leaves state unchanged.
- [x] A dependent of the recorded ticket dispatches.
- [x] Saved state from before this change opens unchanged.
- [x] Full gates, guard and a fresh cold review pass on the accepted revision.
