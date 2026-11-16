# F034-reviewer-retry-create

## Status

- Goal: a reviewer creation interrupted mid-call has a factory exit, so the Foreman no longer
  has to restart cold review by hand.
- Outcome: An interrupted reviewer creation can be retried
- Initial priority: P1. Effort: Small.
- Risk: moderate; it adds a second admitted path into reviewer creation, which starts cold review.
- Depends on: F007-run-transition-table (done).
- Planned at: `fcba87f4cf0d58954768a210c355ab2e0f93a2ba`, 2026-11-16. Local only.

## Why this matters

F007's walking test names `running.reviewerCreation` as an exitless stop. If the process dies
between `review-creating` and `review-created`, the run keeps `review.delivery === "creating"`,
reconcile opens a `creation-unknown` incident, and no control action can move it. The candidate
already passed the worker gates; only the reviewer is missing.

## Current state

- `factory/native.ts` stages the candidate, commits `review-creating` with
  `review.delivery = "creating"`, adds the staging worktree, then `createReviewer` calls
  `host.create` and commits `review-created`. `fallbackReviewer` enters the same state.
- `factory/persistence.ts` declares `running.stops.reviewerCreation` with reason
  `creation-unknown`, recovery `inspect`, `exits: []`, and the note "retry-create admits only
  worker creation".
- `retryCreate` in `native.ts` requires `admitsRun(run, "retry-create")`, which only the
  `creating` kind grants, plus the owner, the exact incident and a decision. It then calls
  `createWorker`.
- `factory/persistence.test.ts` pins `running.reviewerCreation` in `expectedExitless`.

## Approach

Let owner `retry-create` also leave `running.reviewerCreation`, under the same owner, exact
incident and decision checks, as the same proof that no reviewer thread exists. It clears the
incident, records `create-retried`, and calls the existing `createReviewer` for the saved review.
Declare the exit on the stop in the lifecycle table and admit the action through the table, so
`retryCreate` stays the one entry; do not add a second action.

## Scope

- In: the table exit, admission of `retry-create` for that stop, the reviewer branch of
  `retryCreate`, tests, README and foreman.md.
- Out: looking up an ambiguous creation through the host, automatic retry, and the three legacy
  exitless stops.
- Preserve: worker `retry-create` behaves as today; saved state opens unchanged.

## Steps

1. **Declare the reviewer exit**. Add a `retry-create` exit to `running.stops.reviewerCreation`
   and remove it from the walking test's expected exitless set.
2. **Admit through the table**. Make `retry-create` admission read the run's matching stop so a
   running run is admitted only while its review delivery is `creating`.
3. **Recreate the same reviewer**. In `retryCreate`, re-check the staged worktree is unchanged,
   then call `createReviewer` for the saved review instead of `createWorker`.
4. **Document the recovery**. Describe the exit in `factory/README.md` and `factory/foreman.md`.

## Test plan

With the real Git and SQLite fixtures and a fixture host: interrupt `host.create` for a reviewer
and reconcile; one `creation-unknown` incident opens. `retry-create` with the wrong incident, no
decision or a non-owner is refused and creates nothing. With the right incident, one reviewer is
created for the saved revision and review proceeds to a verdict. A worker `creating` run still
retries as before, and a running run whose review is `sent` is refused. A state file written
before this change opens unchanged.

## Why this approach?

- Without it: every interrupted reviewer creation needs a hand-run reviewer outside the factory,
  so the verdict path and its records are bypassed.
- This buys: the existing owner decision is the license for both creations, and one function
  still owns every repeated creation.

## Files You'll Touch

| Path                                                    | Role       | Contains                        | Edit or Read |
| ------------------------------------------------------- | ---------- | ------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Lifecycle  | Table, admission, walking test  | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Recovery   | `retryCreate`, `createReviewer` | Edit         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Exitless stops and recovery     | Edit         |

Build order: table and admission, `retryCreate` branch, tests, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                | Expected result / action                        |
| ------------------------------------------------------ | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`             | Record the dispatch revision; clean tree.       |
| `git diff --stat fcba87f..HEAD -- factory/`            | Revalidate drift, including F009.               |
| `rg -n "reviewerCreation" factory/persistence.ts`      | The exitless stop.                              |
| `rg -n "async function retryCreate" factory/native.ts` | The single repeated-creation entry.             |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`         | Passes; CI runners have no global Git identity. |

## Done when

- [ ] `running.reviewerCreation` has a `retry-create` exit and is no longer exitless.
- [ ] Owner `retry-create` with the exact incident creates one reviewer for the saved revision.
- [ ] Wrong incident, missing decision, non-owner or non-creating review is refused.
- [ ] Worker `retry-create` and saved state behave as before.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

`blocked.withoutWorker` gets no ticket: every current `blocked` write in `native.ts` sets
`thread`, so only legacy saved state reaches it.
