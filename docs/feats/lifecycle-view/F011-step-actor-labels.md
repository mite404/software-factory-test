# F011-step-actor-labels

## Status

- Goal: mark each pipeline step and each lifecycle exit with who performs it: the computer, a
  model, the Foreman or the operator.
- Initial priority: P2. Effort: Small.
- Risk: normal; adds a read-only label to an existing table and projection.
- Depends on: F007-run-transition-table.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

A step the computer performs can be repeated for free and gives the same answer. A step a model
performs costs a turn and can differ. A step the operator performs waits for a person. Knowing
which is which tells the Foreman where a retry is safe and tells the operator what is waiting
for them. The operator approved taking this labelling from a state-machine job runner.

## Current state

- `web/derive.ts` draws seven steps per ticket: worktree, setup, builder thread, `report.json`,
  gate, cold review and merge. The list is a comment beside `STEPS = 7`; no step has an actor.
- F007 adds a table of run kinds, stops and exits, and projects it in `status`. It records no
  actor.
- Control actions are owner-only, but nothing separates an exit the Foreman takes on its own
  from one that needs the operator.

## Approach

Add an `actor` to each exit in the F007 table, one of `computer`, `model`, `foreman` or
`operator`, and to the seven pipeline steps, declared once on the factory side. Include the
label in the read-only status projection and in the dashboard feed. The page shows the actor on
each step as text. Extend the F007 walking test so every exit and step has an actor.

## Scope

- In: the label, its projection, the dashboard step text, tests and README.
- Out: changing who may perform any action, any new retry, and the lifecycle graph itself
  (F012).
- Preserve: step order and count, and every existing feed field.

## Steps

1. **Label exits and steps**. Add the actor to each table exit and declare the seven steps with
   their actors beside the table.
2. **Project the labels**. Include actors in `status` and the dashboard feed without private
   data.
3. **Show actors on steps**. Read the step list from the feed and print each actor on the page.
4. **Test and document**. Extend the walking test and add the actor column to the README.

## Test plan

The walking test fails when an exit or step has no actor. The dashboard feed test expects the
seven steps with their actors. Inspect the rendered page: each step shows its actor at the
default width and nothing overlaps.

## Why this approach?

- Without it: whether a stop can be retried by the machine or needs a person is known only to
  whoever read the code.
- This buys: one declared answer per exit, checked by a test, and shown where the operator
  already looks. Declaring steps on the factory side removes the copy held in a frontend
  comment.

## Files You'll Touch

| Path                                                | Role       | Contains                       | Edit or Read |
| --------------------------------------------------- | ---------- | ------------------------------ | ------------ |
| `factory/persistence.ts`                            | Records    | The F007 table                 | Edit         |
| `factory/native.test.ts`                            | Tests      | The walking test               | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts` | Projection | Feed fields                    | Edit         |
| `web/derive.ts`, `web/derive.test.ts`               | Page model | `STEPS`, `steps`               | Edit         |
| `web/main.ts`, `web/index.html`, `web/style.css`    | Page       | Step drawing                   | Edit         |
| `factory/README.md`                                 | Operation  | Lifecycle table and its actors | Edit         |

Build order: labels, projection, page model, page, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                           | Expected result / action                        |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                        | Record the dispatch revision; clean tree.       |
| `git diff --stat b312722..HEAD -- factory/ web/`                  | Revalidate drift, including F007.               |
| `git diff -- factory/ web/ && git diff --cached -- factory/ web/` | Preserve unrelated changes.                     |
| `rg -n "const STEPS = 7" web/derive.ts`                           | The step list held as a comment.                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`                            | Passes; CI runners have no global Git identity. |

## Done when

- [ ] Every exit and pipeline step has one actor, and a test fails when one is missing.
- [ ] Status and the dashboard feed carry the labels.
- [ ] The page shows each step's actor, checked in a rendered screenshot.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
