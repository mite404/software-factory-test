# F037-two-worker-lanes

## Status

- Goal: the factory runs two workers at once, one per lane: a main lane for most tickets and a
  light lane, on its own model and effort, for tickets marked small and well bounded.
- Outcome: Two lanes run two tickets at once
- Initial priority: P1. Effort: Large.
- Risk: high; it ends the capacity-one rule that dispatch, stops and landing all assume, and a
  second candidate is now built on a base that the first landing moves.
- Depends on: F011-step-actor-labels, so the two do not edit the dispatcher at the same time.
- Planned at: `ddb0fabf1e2f602308f9295c0e3d77c8bc6863d5`, 2026-11-17. Local only.

## Why this matters

The operator wants a main-lane worker (today Opus 5.5 medium) on tickets that need judgment and
a light-lane worker (Sonnet 5.5 high) on small ones, running at the same time. Today one ticket
runs and every other ticket waits, whatever its size.

## Current state

- `factory/native.ts` refuses any definition whose `capacity` is not 1 ("This slice requires
  version 1 and capacity 1").
- `dispatchNext` returns early when any run blocks dispatch, then starts the first eligible
  ticket, so at most one run is open.
- The definition has one `workerModel` and `workerEffort`; each run saves its `workerModel`, and
  the reviewer model comes from that saved provider (`reviewerModel(run.workerModel)`).
- At acceptance, a candidate whose target moved since `run.base` is blocked with
  `target-changed`; otherwise the clone fast-forwards to it. With two lanes, the second
  candidate always finds a moved target.
- During review, a moved target blocks the run with `review-identity-changed`, whose only exit
  is `record-landing`. On 2026-11-17 a Foreman commit to the clone's `.factory.json` (switching
  the worker model) did this to F011 attempt 2 while its reviewer was writing an `issues`
  verdict, and the verdict was never read.
- Queue entries already carry `size` and `risky`.

## Approach

The definition gains an optional `lightWorker: { model, effort }`; `capacity: 2` is valid only
with it. A queue entry with `lane: "light"` runs on the light worker; every other entry runs on
the main lane as today. Dispatch keeps at most one open run per lane. A stop or block in one lane
holds only that lane; factory-wide holds (disabled, owner checks, a pending reload) still hold
both. When a candidate's target moved, at acceptance or during review, the factory rebases it
onto the target in its staging worktree, reruns the full gate on the rebased revision and
reviews that revision; a verdict already written for the old revision is still read and acted
on first. A rebase conflict goes back to the same worker as repair feedback, counting as an
attempt.

## Scope

- In: the definition field and its check, the queue `lane` field, per-lane dispatch and holds,
  the rebase at acceptance, the run's saved lane, tests, README and foreman.md.
- Out: more than two lanes, picking the lane by a model call or by `size` alone, parallel gates
  (the orb has two CPUs; gates queue through the existing test lock), and dashboard layout work
  beyond showing both open runs.
- Preserve: a definition without `lightWorker` and with `capacity: 1` dispatches exactly as
  today; saved state opens unchanged; review routing still follows the run's saved worker.

## Steps

1. **Validate the light lane**. Accept `lightWorker` with a known model family and supported
   effort, and accept `capacity: 2` only when it is present.
2. **Parse the queue lane**. Accept an optional `lane: "light"` on a queue entry and refuse it
   when the definition has no light lane.
3. **Dispatch one per lane**. Start at most one open run per lane, with that lane's model and
   effort saved on the run, and let a lane's own stop hold only that lane.
4. **Rebase a moved candidate**. When the target moved at acceptance or during review, act on
   any verdict already written, then rebase the candidate in staging, rerun the gate and review
   the rebased revision, or send a conflict back as repair feedback.
5. **Document the lanes**. Describe both lanes, how to set them and how landing order works in
   the README and foreman.md.

## Test plan

With fixture hosts: a capacity-one definition dispatches one ticket and leaves the next waiting,
as today. With two lanes, a main and a light ticket both start, each worker created with its
lane's model and effort, and a second light ticket waits. A blocked light run leaves the main
lane dispatching. When the main candidate lands first, the light candidate is rebased, gated and
reviewed at its new revision; a conflicting rebase returns to the same worker thread with
feedback and no landing. A target that moves while a reviewer is writing an `issues` verdict
still sends that verdict to the worker as repair feedback. `capacity: 2` without `lightWorker`,
and `lane: "light"` without a light lane, fail parsing. A state file written before this change
opens unchanged.

## Why this approach?

- Without it: small tickets wait behind long ones, and the second of two parallel candidates
  can only stop at `target-changed` for the Foreman to fix by hand.
- This buys: lanes are chosen by the operator in the queue, not guessed, and a candidate is
  only ever landed on the exact revision the gate and the reviewer saw.

## Files You'll Touch

| Path                                                        | Role       | Contains                              | Edit or Read |
| ----------------------------------------------------------- | ---------- | ------------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts`               | Control    | Definition check, dispatch, rebase    | Edit         |
| `factory/persistence.ts`, `factory/persistence.test.ts`     | Records    | Run lane, per-lane holds              | Edit         |
| `factory/setup-factory.ts`, `factory/setup-factory.test.ts` | Definition | `lightWorker` and capacity options    | Edit         |
| `factory/README.md`, `factory/foreman.md`                   | Operations | Lanes, landing order, rebase feedback | Edit         |
| `factory/review.ts`                                         | Review     | Revision binding for rebased work     | Read         |

Build order: definition, queue lane, dispatch, rebase, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat ddb0fab..HEAD -- factory/`             | Revalidate drift, including F011.               |
| `rg -n "capacity !== 1" factory/native.ts`              | The capacity-one refusal.                       |
| `rg -n "async function dispatchNext" factory/native.ts` | The single dispatcher.                          |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

## Done when

- [ ] With two lanes, a main and a light ticket run at the same time on their own models.
- [ ] A stop in one lane holds only that lane.
- [ ] A candidate whose target moved, at acceptance or during review, is rebased, gated and
      reviewed at its new revision, or returned to its worker on conflict.
- [ ] Without `lightWorker`, dispatch is exactly as today.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
