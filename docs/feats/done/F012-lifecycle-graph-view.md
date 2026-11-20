# F012-lifecycle-graph-view

## Status

- Goal: show the run lifecycle as a graph on the dashboard, with every ticket placed on its
  current state and each state opening the thread that owns it.
- Outcome: The dashboard shows the run lifecycle as a graph
- Initial priority: P2. Effort: Medium.
- Risk: normal; a read-only page section. A wrong drawing can mislead, so it is derived, not
  hand-drawn.
- Depends on: F007-run-transition-table, F011-step-actor-labels and F014-lifecycle-stages, whose
  named stages are the nodes this view draws, and F016-kit-page-default, whose page it is drawn
  on. v1-ticket23 adds richer stage facts and is not required.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

The dashboard shows tickets and links each one to its thread. It does not show the lifecycle:
which states a run can be in, which exits each state has, or where each run sits. On 2026-11-14
a run sat in a state with no exit and nothing on the page could show that. The operator agreed
this view is missing.

## Current state

- `factory/dashboard.ts` maps seven run kinds to five public statuses. `preparing`, `creating`
  and `running` all become `unknown` until an observation refines them, and `uncertain` and
  `preparation-failed` both become `blocked`.
- `web/derive.ts` gives each card an `href` of `https://ampcode.com/threads/<thread>`, opened in
  a new tab.
- No page element lists states or exits.
- F007 projects the lifecycle table in `status`; F011 adds who performs each exit.

## Approach

Add one section to the kit page (`web/spec/tickets.tsx`), drawn from the F007 table and the
F014 stage list in the feed. States on the normal path run left to right. Stops hang below the
state they leave, each with its exits named. Every ticket appears as a marker on its current
state, linked to its thread like a card.

Colour keeps the page's meaning for state: green done, orange now, red blocked with a second
cue that is not colour, unlit queued. `uncertain` has its own cue. Who must act is shown as
text and by order, most urgent first: the operator, the Foreman, a clock, then work in progress,
then quiet states. A clock wait is dim and shows a countdown to its clear time. A count of
tickets waiting for the operator is always visible at the start of the section.

A blocked ticket shows a banner with who must act, the declared reason code and its label from
the feed, the exit action, the thread that caused the stop with its role, and when it stopped.
Add `web/replay.ts` frames for each case in the test plan.

The feed gains the run's real kind and stop reason as curated values, so the graph does not
infer a state from the five public statuses.

## Scope

- In: the feed fields, the page section, its model and tests, and README.
- Out: editing the lifecycle from the page, control actions from the page, per-check results
  (v1-ticket23), and animation.
- Preserve: every existing page element and feed field; private briefs, reports and reasons
  beyond the declared reason value stay private.

## Steps

1. **Feed the real state**. Add the run kind, the declared stop reason and the table to the
   dashboard feed, with a privacy test.
2. **Model the graph**. Derive nodes, exits and ticket markers from the feed in `web/derive.ts`,
   ordered by who must act.
3. **Draw the section**. Render the graph in the existing page style, with thread links on
   markers and on states that have an owning thread.
4. **Check it rendered**. Inspect screenshots for an empty factory, one running ticket, one
   stopped ticket and several tickets on one state.
5. **Document the view**. Describe the section and its ordering in the README.

## Test plan

Model tests: a table with a state that has no exit draws that state marked as exitless; a
ticket in each kind lands on the matching node; operator-owned stops sort first. Feed test: a
planted private canary never appears. Rendered check at the default and a narrow width, with
the four states listed in the steps.

## Why this approach?

- Without it: the page can say a ticket is blocked but not what can unblock it or who must.
- This buys: the drawing comes from the same table the factory acts on, so the page cannot show
  an exit the factory does not have. Sorting by who must act puts the operator's own queue
  first.

## Files You'll Touch

| Path                                                            | Role       | Contains                      | Edit or Read |
| --------------------------------------------------------------- | ---------- | ----------------------------- | ------------ |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`             | Projection | Public statuses and feed      | Edit         |
| `web/derive.ts`, `web/derive.test.ts`                           | Page model | Cards, steps, thread links    | Edit         |
| `web/spec/tickets.tsx`, `web/spec/tickets.css`, `web/replay.ts` | Page       | Drawing                       | Edit         |
| `factory/persistence.ts`                                        | Records    | The lifecycle table from F007 | Read         |
| `factory/README.md`                                             | Operation  | Dashboard sections            | Edit         |

Build order: feed, model, drawing, rendered check, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                           | Expected result / action                        |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                        | Record the dispatch revision; clean tree.       |
| `git diff --stat b312722..HEAD -- factory/ web/`                  | Revalidate drift, including F007 and F011.      |
| `git diff -- factory/ web/ && git diff --cached -- factory/ web/` | Preserve unrelated changes.                     |
| `rg -n "ampcode.com/threads" web/derive.ts`                       | The existing thread link.                       |
| `bun run web:build`                                               | The page builds.                                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`                            | Passes; CI runners have no global Git identity. |

## Done when

- [x] The page shows every run kind, its stops and their exits from the declared table.
- [x] Each ticket sits on its current state and opens its thread.
- [x] States that wait for the operator come first, with a visible count.
- [x] No private field reaches the feed.
- [x] Rendered screenshots of the four cases are inspected and attached to the report.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
