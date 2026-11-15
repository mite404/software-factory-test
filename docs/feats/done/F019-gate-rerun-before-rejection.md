# F019-gate-rerun-before-rejection

## Status

- Goal: a gate failure caused by machine load does not reject a correct candidate. The factory
  runs a failed gate a second time, and only two failures in a row reject.
- Initial priority: P1. Effort: Small.
- Risk: elevated; changes when a candidate is rejected. A wrong rule could accept a candidate
  that fails its gate, so a pass is still required and nothing is ever accepted on a failure.
- Depends on: F008-gate-failure-feedback, whose rejection message this ticket extends.
- Planned at: `a96cec001fa00b4d787a5b0893cfe18a8da74263`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the Foreman ran the full gate on a docs branch while the factory ran its own gate
on F008 attempt 2. The orb has 2 CPUs. Five tests failed with "this test timed out after
5000ms"; the same commit passed 201 of 201 when run alone, in 120 seconds against 215 under
load. The factory can meet the same load without the Foreman: a worker runs the gate in its
worktree and a cold reviewer may run tests while the factory gates another attempt. A timeout
there is recorded as a rejection, spends one of the two repair attempts before escalation, and
sends the worker to repair code that is correct. The operator called that undesired on the same
day. It has not yet been observed on a factory gate.

## Current state

- `candidateEvidence` in `factory/native.ts` calls `verify` once. Any nonzero exit rejects.
- `verify` runs the configured command with a 600,000 ms cap and writes one log,
  `<ticket>-<attempt>.log`.
- `reject` counts the rejection toward escalation: every second rejection stops for the Foreman.
- F008 sends the worker the exit status and the end of stdout and stderr.
- Tests use Bun's default 5,000 ms per-test timeout; the repository has no `bunfig.toml`.
- Nothing stops two gates, or a gate and a worker's own test run, from overlapping.

## Approach

When the gate exits nonzero, run it once more in the same worktree before deciding, after
confirming HEAD is still the candidate and the tree is clean. A pass on the second run is a
pass: the candidate goes on to cold review, and the factory records an event, `gate-flaked`,
with both log paths, so the weekly failure audit (F015) can count flakes. A second failure
rejects as today, and the worker's message says the gate failed twice and quotes the second run.
Keep each run's log: `<ticket>-<attempt>.log` and `<ticket>-<attempt>.rerun.log`.

Do not rerun when the gate did not run (a precondition failed), when the first run hit the
ten-minute cap, or when the candidate changed between runs.

Also give this repository's tests room: add `bunfig.toml` with a 20,000 ms per-test timeout, so
load slows the suite down instead of failing it. The rerun stays, because other projects the
factory serves have their own gates.

## Scope

- In: the rerun in `factory/native.ts`, the event, the rejection text for a double failure,
  `bunfig.toml`, tests, README and foreman.md.
- Out: classifying failures by reading their output, a lock that serializes gates across
  processes, cold reviewers' own test runs, and the escalation rule.
- Preserve: a failing gate never leads to acceptance; a precondition failure and a cap timeout
  reject at once; F008's message for a single deterministic failure keeps its content.

## Steps

1. **Reproduce a load flake**. Write a fixture gate that fails on its first run and passes on
   its second, and watch the current code reject it.
2. **Rerun a failed gate**. Run the gate a second time on a nonzero exit, keep both logs, and
   skip the rerun for a precondition failure, a cap timeout or a changed candidate.
3. **Record the flake**. Append `gate-flaked` with both log paths when the second run passes.
4. **Word the double failure**. Tell the worker the gate failed twice and quote the second run.
5. **Lengthen test timeouts**. Add `bunfig.toml` with the per-test timeout and confirm the suite
   reads it.
6. **Document the rule**. Describe the rerun, the event and the skip cases in the README and
   foreman.md.

## Test plan

With the real Git and SQLite fixtures: a gate that fails then passes sends the candidate to
review, records one `gate-flaked` event and no rejection, and leaves the attempt number
unchanged. A gate that fails twice rejects once, with both logs kept and the second run quoted.
A gate that passes first time runs once. A precondition failure and a cap timeout run once and
reject. A candidate whose HEAD moves between the runs is rejected without a second verdict. The
count toward escalation rises by one per double failure, not two. `bun test` prints the
configured timeout for a deliberately slow fixture, or the fixture passes at 6 seconds.

## Why this approach?

- Without it: one slow moment on a two-CPU orb costs a repair attempt and can push a correct
  ticket to escalation.
- This buys: a rejection needs the same result twice, which a real defect gives and load rarely
  does, at the cost of one extra gate run only when a gate fails. It needs no guess about what
  a failure "looks like", and a failed gate still can never be accepted.

## Files You'll Touch

| Path                                          | Role        | Contains                                                | Edit, Create or Read |
| --------------------------------------------- | ----------- | ------------------------------------------------------- | -------------------- |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle   | `verify`, `candidateEvidence`, `reject`, `gateFeedback` | Edit                 |
| `bunfig.toml`                                 | Test runner | Per-test timeout                                        | Create               |
| `factory/README.md`, `factory/foreman.md`     | Operations  | Gate and rejection rules                                | Edit                 |
| `factory/persistence.ts`                      | Records     | Event append                                            | Read                 |

Build order: reproduction, rerun, event, message, timeout, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                      | Expected result / action                        |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                   | Record the dispatch revision; clean tree.       |
| `git diff --stat a96cec0..HEAD -- factory/`                  | Revalidate drift.                               |
| `git diff -- factory/ && git diff --cached -- factory/`      | Preserve unrelated changes.                     |
| `rg -n "async function candidateEvidence" factory/native.ts` | Where the gate result is decided.               |
| `rg -n "function gateFeedback" factory/native.ts`            | Present; F008 merged.                           |
| `ls bunfig.toml`                                             | Missing.                                        |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`               | Passes; CI runners have no global Git identity. |

## Done when

- [x] A gate that fails once and then passes does not reject, and records `gate-flaked`.
- [x] A gate that fails twice rejects once, with both logs kept.
- [x] A precondition failure, a cap timeout and a changed candidate are never rerun.
- [x] No failing gate result can lead to acceptance.
- [x] The suite's per-test timeout is 20 seconds.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

`bunfig.toml` is outside the factory's allowed paths (`factory/`, `web/`); the Foreman widens
the scope for this ticket or adds the file in the integration pull request.
