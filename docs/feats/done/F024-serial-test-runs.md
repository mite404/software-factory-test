# F024-serial-test-runs

## Status

- Goal: two test runs of this repository never execute at the same time on one machine, whoever
  starts them, so no run fails because another one was using the CPUs.
- Outcome: Test runs on one machine take turns
- Initial priority: P1. Effort: Small.
- Risk: normal; it changes when tests start, not what they assert. A lock that is never released
  would stop every gate, so a dead holder must not hold it.
- Depends on: nothing. F019-gate-rerun-before-rejection handles a flake that still happens;
  this ticket removes the main cause.
- Planned at: `5fbb1604d8160444cb5346fceaf31bf0cb54e6f0`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the Foreman's gate and the F021 worker's baseline ran together on the two-CPU orb
and both timed out. It was the second time. The rule "do not overlap test runs" lived in the
Foreman's notes, and the operator asked for rules like it to be enforced by the machine instead
of remembered. Each overlap costs a worker round trip and a four-minute rerun.

## Current state

- `bun test` is started by four callers that know nothing of each other: the factory gate
  (`verify` in `factory/native.ts`, which runs the definition's `verify` command), a worker in
  its worktree, the Foreman's local gate, and `bun run test` in `package.json`.
- Worktrees and the dogfood clone are separate checkouts of this repository on the same machine.
- `verify` stops a gate after a fixed 600 000 ms.
- There is no `bunfig.toml`. F019 plans one for a 20 s test timeout.
- `flock` is installed on the orb at `/usr/bin/flock`. CI runs one `bun run test` per machine.

## Approach

Make the lock part of running the tests, not part of any caller. Add a Bun test preload, named
in `bunfig.toml`, that takes one machine-wide lock before the first test file loads and holds it
until the process exits. Every `bun test` in any checkout of this repository then waits its
turn. The lock is an operating-system file lock on a fixed path under the system temporary
directory, so it is released when its holder dies, however it dies.

While waiting, print one line to stderr naming the holder's process ID and how long the wait
has lasted, every 30 s. Waiting happens before any test's timer starts, so no test timeout
counts it. The factory gate's 600 000 ms budget does count it; start that budget's clock only
once the lock is held, or leave it and say so in the README, whichever the code makes simpler.

## Scope

- In: the preload, `bunfig.toml`, one test, and a README paragraph.
- Out: limiting browsers, builds or lint. They are lighter and F019's longer timeout covers them.
- Out: more than one machine, and running test files in parallel inside one run.
- Preserve: a lone test run starts with no measurable delay and CI behaves as today.

## Steps

1. **Reproduce the overlap**. Start two test runs of a small fixture together and record that
   both execute at once today.
2. **Take a machine lock**. Add the preload and `bunfig.toml` entry so a second run waits for
   the first and then runs.
3. **Survive a dead holder**. Prove that killing the holder with SIGKILL lets the waiting run
   start.
4. **Report the wait**. Print the holder and the elapsed wait while waiting, and decide how the
   gate budget counts it.
5. **Document the lock**. Describe the lock path, the wait line and the gate budget rule in the
   README, and remove the "do not overlap" advice from `foreman.md` if present.

## Test plan

- Two concurrent runs of a fixture whose one test sleeps 2 s: the second run's test starts
  after the first run's process has exited. Compare recorded start and exit times, not a sleep.
- Kill the first run with SIGKILL while the second waits: the second starts within 2 s.
- A lone run prints no wait line.
- A run from a second checkout path waits for a run in the first.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: every caller must check for the others. Three callers forgot or could not know
  on 2026-11-15, and a guard in one caller does nothing for a worker that runs `bun test`
  directly.
- This buys: one owner for the rule, the test runner itself. A caller cannot skip it by
  accident, and an operating-system lock cannot be left behind by a crash.

## Files You'll Touch

| Path                        | Role              | Contains                       | Edit or Read |
| --------------------------- | ----------------- | ------------------------------ | ------------ |
| `bunfig.toml`               | Test settings     | The preload entry              | Create       |
| `factory/test-lock.ts`      | Preload           | Take and hold the machine lock | Create       |
| `factory/test-lock.test.ts` | Proof             | Concurrent, dead-holder, lone  | Create       |
| `factory/native.ts`         | Gate              | `verify` and its 600 000 ms    | Read or Edit |
| `factory/README.md`         | Operator contract | Lock path, wait line, budget   | Edit         |
| `factory/foreman.md`        | Foreman prompt    | Drop manual overlap advice     | Edit         |
| `.factory.json`             | This repo's setup | Add `bunfig.toml` to the scope | Coordinator  |

Build order: the fixture and failing test, the preload, the gate budget decision, the documents.
If F019 has landed, `bunfig.toml` exists; add to it.

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record it; explain differences from the planning SHA. |
| `git status --short`                        | Clean, or every edit accounted for.                   |
| `git diff --stat 5fbb160..HEAD -- factory/` | Revalidate `verify` and its timeout.                  |
| `ls bunfig.toml`                            | Absent, or F019's file; extend it, do not replace it. |
| `command -v flock`                          | Present, if the lock uses it.                         |
| `bun test factory`                          | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`      | No errors.                                            |
| `bun run format:check && bun run fallow:ci` | Pass.                                                 |
| `bash factory/checks.sh guard`              | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [x] Two test runs started together on one machine execute one after the other, from any two
      checkouts, with no caller doing anything.
- [x] A killed holder does not block the next run.
- [x] A waiting run says who holds the lock and for how long.
- [x] A lone run and CI behave as before.
- [x] Full gates, guard and a fresh cold review pass on the accepted revision.
