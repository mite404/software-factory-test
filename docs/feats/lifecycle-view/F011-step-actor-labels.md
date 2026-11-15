# F011-step-actor-labels

## Status

- Goal: mark each pipeline step and each lifecycle exit with who performs it: the computer, a
  model, the Foreman or the operator. Link every model step, and every stop, to the thread that
  performed or caused it.
- Initial priority: P2. Effort: Medium.
- Risk: normal; adds read-only labels and thread references to an existing table and projection.
  A stop gains one recorded field.
- Depends on: F007-run-transition-table, and F016-kit-page-default, which makes the kit page
  the only page these steps are drawn on.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

A step the computer performs can be repeated for free and gives the same answer. A step a model
performs costs a turn and can differ. A step the operator performs waits for a person. Knowing
which is which tells the Foreman where a retry is safe and tells the operator what is waiting
for them. The operator approved taking this labelling from a state-machine job runner.

The operator also asked for a link to the thread that errored, so an agent that keeps failing
can be examined in its own transcript. On 2026-11-14 a reviewer thread errored and the stop
notice said `worker-error`; nothing recorded which thread it was.

## Current state

- `web/derive.ts` draws seven steps per ticket: worktree, setup, builder thread, `report.json`,
  gate, cold review and merge. The list is a comment beside `STEPS = 7`; no step has an actor.
- F007 adds a table of run kinds, stops and exits, and projects it in `status`. It records no
  actor.
- Control actions are owner-only, but nothing separates an exit the Foreman takes on its own
  from one that needs the operator.
- `StopIncident` in `factory/persistence.ts` records the Foreman as `owner`. It has no field for
  the thread whose error or rejection caused the stop.
- `projectTask` in `factory/dashboard.ts` gives each ticket one `thread`. While a review record
  exists it is replaced by the reviewer's thread, so the page links to one of the two and never
  both.
- Each attempt gets a fresh reviewer thread. Earlier reviewers appear only in the event log
  (`review-created`, `review-verdict`, `rejected`).

## Approach

Add an `actor` to each exit in the F007 table, one of `computer`, `model`, `foreman` or
`operator`, and to the seven pipeline steps, declared once on the factory side. Include the
label in the read-only status projection and in the dashboard feed. The kit page
(`web/spec/tickets.tsx`) makes the actor readable on each stage badge; a glyph with a tooltip
and an accessible name is enough. Extend the F007 walking test so every exit and step has an
actor. Add a frame with actors and a stopped reviewer to `web/replay.ts`.

Record on each new stop the thread that caused it and its role, `worker` or `reviewer`. The
feed carries the worker thread and the current reviewer thread separately, the stop's thread,
and for each rejected attempt the reviewer thread that rejected it, read from the event log.
On the page the builder step links to the worker, the cold review step to that attempt's
reviewer, a failed step to the thread that failed, and a short list of earlier rejections links
to their reviewers. The stop notice names the role from the recorded field.

## Scope

- In: the label, the stop's thread and role, their projection, the dashboard step text and
  links, the notice wording, tests and README.
- Out: changing who may perform any action, any new retry, the lifecycle graph itself (F012),
  and showing verdict text or any transcript content on the page.
- Preserve: step order and count, every existing feed field including the single `thread`, and
  saved stops without the new field, which show no failed-thread link.

## Steps

1. **Label exits and steps**. Add the actor to each table exit and declare the seven steps with
   their actors beside the table.
2. **Project the labels**. Include actors in `status` and the dashboard feed without private
   data.
3. **Show actors on steps**. Read the step list from the feed and print each actor on the page.
4. **Record the failing thread**. Save the causing thread and its role on each new stop, and
   word the stop notice from that role.
5. **Link steps to threads**. Project the worker, reviewer, stop and past-rejection threads, and
   link each model step and failed step on the page.
6. **Test and document**. Extend the walking test and add the actor column to the README.

## Test plan

The walking test fails when an exit or step has no actor. The dashboard feed test expects the
seven steps with their actors. With the real Git and SQLite fixtures, a reviewer thread error
records the reviewer's thread with role `reviewer`, and the notice says reviewer; a worker
error records the worker. After two rejections the feed lists both rejecting reviewer threads
in attempt order. Thread references are validated as thread IDs and a planted private canary
stays out of the feed. A stop saved before this change still opens. Inspect the rendered page:
each step shows its actor, a failed cold review links to the reviewer and not the worker, and
nothing overlaps at the default width.

## Why this approach?

- Without it: whether a stop can be retried by the machine or needs a person is known only to
  whoever read the code.
- This buys: one declared answer per exit, checked by a test, and shown where the operator
  already looks. Declaring steps on the factory side removes the copy held in a frontend
  comment.

## Files You'll Touch

| Path                                                            | Role       | Contains                                 | Edit or Read |
| --------------------------------------------------------------- | ---------- | ---------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts`         | Records    | The F007 table, `StopIncident`           | Edit         |
| `factory/native.ts`, `factory/native.test.ts`                   | Lifecycle  | Stop creation, notice text, walking test | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`             | Projection | Feed fields                              | Edit         |
| `web/derive.ts`, `web/derive.test.ts`                           | Page model | `STEPS`, `steps`                         | Edit         |
| `web/spec/tickets.tsx`, `web/spec/tickets.css`, `web/replay.ts` | Page       | Step drawing                             | Edit         |
| `factory/README.md`                                             | Operation  | Lifecycle table and its actors           | Edit         |

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
- [ ] Each new stop records the thread that caused it and whether it was the worker or reviewer.
- [ ] The page links the builder step to the worker, the review step to its reviewer, a failed
      step to the failing thread, and earlier rejections to their reviewers.
- [ ] The actor is readable on each step of the kit page, and the links are shown, checked in a
      rendered screenshot.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

v1-ticket23 also plans to keep the worker's identity separate from the reviewer's in the feed.
Whichever ticket lands second reuses the first one's fields instead of adding its own.
