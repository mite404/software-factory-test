# F010-brief-fact-check

## Status

- Goal: refuse to start a worker when its brief is missing a fact, and say which fact.
- Outcome: A worker refuses a brief with a missing fact
- Initial priority: P2. Effort: Small.
- Risk: normal; adds a refusal before creation and changes no accepted behavior.
- Depends on: F007-run-transition-table, so the new stop enters the declared table.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

A worker thread is the expensive step. A brief with a missing fact produces a worker that
guesses, and the gap shows up later as a rejection. The operator approved taking the idea of
brief templates that report their own missing slots before a model runs.

## Current state

- `prompt` in `factory/native.ts` builds the worker brief as one template string from the queue
  entry's `brief`, the pinned scope and `verify`, the definition digest, dependency insights, any
  repair feedback and the Foreman thread.
- A queue `brief` is normally a pointer such as `Implement docs/feats/<feature>/<ticket>.md`.
  Nothing checks that the file exists at the run's base revision.
- A run without a pinned definition prints `legacy unpinned`.
- Missing dependency insights print `none`, which also is what a ticket with no dependencies
  prints.
- `dispatchNext` already refuses to start with a dirty root. It checks nothing about the brief.

## Approach

Add one pure function that lists what a brief lacks, given the queue entry, the pinned definition
and the base revision: a ticket file named in the brief that does not exist at the base, an
empty scope or `verify`, no pinned definition, and a dependency in `after` that is `done` with an
empty insight. `dispatchNext` calls it before any worktree or thread is created. A non-empty
list blocks the ticket with reason `brief-incomplete`, names each missing fact, and holds the
queue like any other stop. The exit is a queue or definition fix followed by `reload`.

## Scope

- In: the check, the stop and its table entry, tests, and one README paragraph.
- Out: typed templates for other messages, rewriting the brief wording, and validating a ticket
  file's sections.
- Preserve: a complete brief produces the same text as today.

## Steps

1. **List the missing facts**. Write the pure check and its cases for each missing fact and for
   a complete brief.
2. **Refuse before creation**. Call the check in dispatch ahead of setup and creation, and block
   with the named facts.
3. **Declare the stop**. Add `brief-incomplete` to the allowed reasons and the lifecycle table
   with `reload` as its exit.
4. **Document the refusal**. Describe the stop and its fix in the README.

## Test plan

With the real Git and SQLite fixtures: a queue entry whose brief names a ticket file absent at
the base is blocked, no worktree or thread exists afterward, and the reason names the file.
Fixing the queue and reloading starts the ticket. A complete entry starts as today and its brief
text is unchanged.

## Why this approach?

- Without it: an incomplete brief costs a worker run and at least one rejection before anyone
  sees the cause.
- This buys: the check runs on the Foreman's side before any model is asked, so the cost of a
  bad brief is one status line. A pure function keeps it testable without threads.

## Files You'll Touch

| Path                                                    | Role      | Contains                           | Edit or Read |
| ------------------------------------------------------- | --------- | ---------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle | `prompt`, `dispatchNext`, the stop | Edit         |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records   | Allowed incident reasons           | Edit         |
| `factory/README.md`                                     | Operation | Dispatch refusals                  | Edit         |

Build order: check and its test, dispatch refusal, reason and table entry, README.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat b312722..HEAD -- factory/`             | Revalidate drift, including F007.               |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `rg -n "async function prompt" factory/native.ts`       | The brief template.                             |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

## Done when

- [x] A brief with a missing fact starts no worktree and no thread.
- [x] The stop names every missing fact and has a tested exit.
- [x] A complete brief is byte-identical to today's.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
