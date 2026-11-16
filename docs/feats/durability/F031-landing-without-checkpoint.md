# F031-landing-without-checkpoint

## Status

- Goal: the owning Foreman can record an outside landing for a blocked run that has no saved
  worker checkpoint, such as a `target-changed` block, with the same Git proof `record-landing`
  already requires.
- Outcome: A blocked run without a checkpoint can record its landing
- Initial priority: P1. Effort: Small.
- Risk: elevated; this writes a done run without the native gate or review. The identity it
  proves against must come from durable state the factory wrote, never from the request.
- Depends on: F030-record-external-landing (done).
- Planned at: `6ebffce6d338f999ca796863af2a9f616d2df8ec`, 2026-11-16. Local only.

## Why this matters

F005's run blocked with reason `target-changed` after the Foreman moved the clone's root during
attempt 2. The candidate was gated, cold-reviewed and merged as PR #56 with operator approval,
but `record-landing` refuses it: "Landing requires a blocked ticket and its exact current
incident with no queued repair". F007 lists F005 in `after`, so F007 and the tickets behind it
cannot dispatch, and the watchdog keeps reporting an incident with nothing left to do.

## Current state

- `verifiedLanding` in `factory/native.ts` reads `run.repair ?? run.checkpoint` and throws when
  neither exists. It uses that checkpoint for `base`, `attempt`, `thread` and `worktree`.
- Both `target-changed` transitions in `factory/native.ts` write
  `{ kind: "blocked", definition, thread, reason, executor }` with no checkpoint.
- The incident still records `ticket`, `owner`, `base` and `attempt`, and the worker worktree is
  always `join(directory, "worktrees", task.id)`.
- `stoppedRun` gives a blocked run without repair or checkpoint the recovery `inspect`.

## Approach

- When a blocked run has no repair and no checkpoint, `verifiedLanding` takes `base` and
  `attempt` from the run's saved incident, `thread` from the run, and the worktree from the
  registered worker path. The incident must still match the request's ID, ticket and owner.
- Every existing proof stays: the revision descends from the base and is reachable from the
  worker worktree HEAD, `verifyMerge` finds the patch and merge commit upstream, and the merge is
  in the root HEAD.
- A run with a queued repair or checkpoint keeps today's path unchanged. Recovery for
  `target-changed` stays `inspect`; `resume` is not added.

## Scope

- In: the fallback in `verifiedLanding`, tests, and README and `foreman.md` notes.
- Out: changing `target-changed` transitions, adding resume for them, or changing
  `record-merge`.
- Preserve: every existing state, action and saved record loads and behaves as before.

## Steps

1. **Derive checkpoint-less identity**. When a blocked run has neither repair nor checkpoint, take
   base and attempt from its saved incident, thread from the run, and the worktree from the
   registered worker path, refusing if any is missing.
2. **Keep every landing proof**. Run the same ancestry, `verifyMerge` and root HEAD checks on that
   identity, so a mismatch throws and changes nothing.
3. **Document the recovery**. Say in the README and `foreman.md` that a `target-changed` block can
   be recorded once its candidate lands.

## Test plan

- A `target-changed` blocked run whose candidate patch is upstream and merged into root HEAD
  becomes done with its merge recorded, closes its incident, and a dependent then dispatches.
- Each rejection changes nothing: wrong incident ID, non-owner, a revision that does not descend
  from the incident base, a revision not reachable from the worker worktree HEAD, a patch not
  upstream, a merge commit not in root HEAD, and an incident missing base or attempt.
- Existing checkpoint and repair landings behave as before; the same request twice is repeat-safe.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: any block that saves no checkpoint stays blocked forever once its candidate lands
  outside the factory, and the only workarounds are editing `after` or hand-editing private state.
- This buys: identity comes from the incident and registered worktree the factory itself wrote,
  so the request cannot choose what it is proved against, and the Git proof is unchanged.

## Files You'll Touch

| Path                     | Role              | Contains                                 | Edit or Read |
| ------------------------ | ----------------- | ---------------------------------------- | ------------ |
| `factory/native.ts`      | Lifecycle         | `verifiedLanding`, `target-changed` runs | Edit         |
| `factory/native.test.ts` | Lifecycle proof   | Landing without checkpoint, rejections   | Edit         |
| `factory/plugin.ts`      | Control surface   | `record-landing` description             | Read or Edit |
| `factory/README.md`      | Operator contract | Recovery actions                         | Edit         |
| `factory/foreman.md`     | Foreman guide     | When to record an outside landing        | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                                              | Expected result / action                              |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                                                 | Record it; explain differences from the planning SHA. |
| `git status --short`                                                 | Clean, or every edit accounted for.                   |
| `rg -n "function verifiedLanding\|target-changed" factory/native.ts` | Revalidate the landing path and both block sites.     |
| `bun test factory`                                                   | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`                               | No errors.                                            |
| `bun run format:check && bun run fallow:ci`                          | Pass.                                                 |
| `bash factory/checks.sh guard`                                       | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] The owner can record a checkpoint-less blocked run as landed only with Git proof of its
      exact patch against the incident's saved base.
- [ ] Every rejected request leaves state unchanged.
- [ ] A dependent of the recorded ticket dispatches.
- [ ] Checkpoint and repair landings and saved state from before this change behave unchanged.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
