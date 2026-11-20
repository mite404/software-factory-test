# F008-gate-failure-feedback

## Status

- Goal: a failed gate returns the failing check and its output to the worker, not a log path.
- Outcome: A failed gate returns its check and output
- Initial priority: P0. Effort: Small.
- Risk: normal; changes the text of one repair message and nothing about acceptance.
- Depends on: F003-provider-limit-resume, only because both edit the rejection path in
  `factory/native.ts`.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

The operator named this the highest-leverage idea taken from a state-machine job runner: a
failed check is the next input to the same worker. The factory already returns a gate failure to
the same worker, but the worker has to find the failure itself, and a wasted repair attempt
counts toward the two-rejection escalation.

## Current state

- `verifyCandidate` in `factory/native.ts` runs the pinned `verify` command once and writes
  stdout, stderr and any error to `<ticket>-<attempt>.log`. It returns the log path.
- On a non-zero status the caller runs `reject(task, run, log)`. The repair message is
  `Verification rejected attempt N. Evidence: <log path>. Repair the candidate ...`.
- The F003 attempt 1 log is 114,035 bytes. The worker receives only its path.
- A review rejection passes the verdict text as evidence, so the reviewer path already carries
  its findings.
- When the candidate revision, clean tree or allowed-path check fails, the log holds one fixed
  sentence and no command ran.
- The gate is one shell command. Which of its parts failed is not recorded.

## Approach

Build the repair evidence from the gate result instead of the path: the exit status, the last
part of the combined output cut to a fixed byte limit on a line boundary, and the log path for
the rest. For the no-command case, say which precondition failed. Keep the log file and the
event record unchanged.

Do not parse per-tool output or split the gate into checks; v1-ticket11 owns named checks.

## Scope

- In: the evidence string for a gate rejection, its test, and one README sentence.
- Out: named per-check results (v1-ticket11), review rejection text, the escalation count, and any
  retry inside the gate.
- Preserve: the log file, the `rejected` and `escalated` events, and the blocked reason format
  that `resume` reads.

## Steps

1. **Excerpt the gate output**. Add a pure function that turns a gate result into a bounded
   excerpt ending on a line boundary, with the exit status first.
2. **Name the failed precondition**. Return which of candidate revision, clean tree or allowed
   paths failed instead of one fixed sentence.
3. **Send the excerpt back**. Pass the excerpt and the log path as rejection evidence, leaving
   events and the escalation rule as they are.
4. **Document the feedback**. State in the README what a worker receives after a gate failure.

## Test plan

Using the real Git and SQLite fixtures in `factory/native.test.ts`: a gate that prints a long
passing section and then one failing line produces a repair message that contains the failing
line and the exit status and stays under the limit. A gate that fails with no output still
names the status. Each precondition failure names itself. A review rejection message is
unchanged.

## Why this approach?

- Without it: the worker spends its first repair turns locating the failure in a large log, and
  can repair the wrong thing; two wasted attempts stop the queue for the Foreman.
- This buys: the same worker, the same gate and the same count, with the failure in front of the
  worker. Bounding the excerpt keeps one noisy gate from filling the worker's context.

## Files You'll Touch

| Path                     | Role      | Contains                                  | Edit or Read |
| ------------------------ | --------- | ----------------------------------------- | ------------ |
| `factory/native.ts`      | Lifecycle | `verifyCandidate`, `reject`, repair text  | Edit         |
| `factory/native.test.ts` | Tests     | Rejection and repair with real Git/SQLite | Edit         |
| `factory/review.ts`      | Exemplar  | How review evidence reaches the worker    | Read         |
| `factory/README.md`      | Operation | Verification and repair                   | Edit         |

Build order: excerpt function and its test, precondition names, rejection wiring, README.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat b312722..HEAD -- factory/`             | Revalidate drift, including F003.               |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `rg -n "await reject\(task, run, log\)" factory/`       | One call in `factory/native.ts`.                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

## Done when

- [x] A gate rejection message contains the exit status and the end of the gate output.
- [x] The excerpt has a fixed byte limit and the full log path follows it.
- [x] A precondition failure names the precondition.
- [x] Review rejection text, events and the escalation rule are unchanged.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
