# F009-attempt-cap-parking

## Status

- Goal: after a second escalation fails, park the ticket, alert the operator, and let the queue
  continue with tickets that do not depend on it.
- Outcome: A twice-failed ticket parks while the queue continues
- Initial priority: P1. Effort: Medium.
- Risk: elevated; adds a run kind and changes which runs hold the queue.
- Depends on: F007-run-transition-table, so the new kind and its exit enter the declared table.
- Planned at: `b3127226af36e10022461c1c626ea2602c70948c`, 2026-11-15. Local only.

## Why this matters

The operator asked for a cap: after the Foreman has been escalated to once and two more tries
fail, stop spending on that ticket, tell the operator, and start the next ticket unless it needs
the parked one. Today a hard ticket can hold the whole queue for as long as the Foreman keeps
resuming it.

## Current state

- `reject` in `factory/native.ts` sends the worker back on odd attempts and escalates on even
  ones: the run becomes `blocked` with `repair` set and reason `verification-rejected`.
- Owner-only `resume` continues the same worker at the next attempt. Nothing limits how many
  times this repeats.
- `dispatchNext` returns early while any run is `running` or `blocked` with `repair`, so an
  escalated ticket holds every other ticket.
- A ticket starts only when every id in its `after` list is `done`, so dependents of an
  unfinished ticket already wait.
- The watchdog reserves and delivers operator alerts through `amp.notify_user`
  (`factory/watchdog.ts`), with alert kinds `unresolved` and `spending`.

## Approach

Add a run kind `parked`. When attempt four is rejected, which is the second escalation, the run
becomes `parked` instead of `blocked`. It keeps the same checkpoint a blocked repair keeps, so
the same worker can continue later. `dispatchNext` does not count a parked run as active; the
existing `after` rule keeps its dependents queued.

Parking reserves one operator alert through the existing alert path, with a new alert kind. The
only exit is owner `resume` with the exact incident and a decision, the same call that leaves an
escalation today. Leaving `parked` requires that no other run is active, as `resume` does now.

The cap is a constant of four rejections. It is not a setting.

## Scope

- In: the `parked` kind, its validation, the rejection branch, the dispatch rule, one alert, the
  table entry from F007, the dashboard status mapping, tests, README and foreman.md.
- Out: a configurable cap, automatic unparking, replacing the worker, and any change to the first
  escalation.
- Preserve: saved state opens unchanged, and attempts one to three behave as today.

## Steps

1. **Add the parked kind**. Declare and validate `parked` with its checkpoint and incident, and
   add it to the lifecycle table with `resume` as its exit.
2. **Park at the cap**. Send the fourth rejection to `parked` with reason
   `verification-rejected`, keeping the repair checkpoint.
3. **Release the queue**. Stop counting a parked run as active in dispatch, and prove a
   dependent ticket stays queued while an independent one starts.
4. **Alert the operator once**. Reserve one alert when a run parks, using the existing
   reservation and delivery path, and never resend an uncertain one.
5. **Resume a parked run**. Let owner `resume` continue the same worker from `parked` under the
   same checks as an escalation.
6. **Show and document it**. Map `parked` to the dashboard's blocked status and describe the cap
   in the README and foreman.md.

## Test plan

With the real Git and SQLite fixtures: four rejections park the run, and a fifth worker message
is not sent. A queue of three tickets, where the second lists the parked one in `after` and the
third does not, starts the third and leaves the second queued. One alert is reserved; a restart
with the alert in `sending` does not send a second. `resume` with the wrong incident is refused;
with the right one the same thread continues at attempt five. A state file written before this
change opens unchanged.

## Why this approach?

- Without it: either the queue waits on one ticket indefinitely, or a hard limit throws away the
  worker's context. Reusing `blocked` would keep holding the queue, because dispatch cannot tell
  a ticket waiting for the Foreman from one waiting for the operator.
- This buys: a separate kind makes "waiting for the operator" visible and lets dispatch skip it.
  Keeping the checkpoint means the cap costs no worker knowledge. The existing `after` rule is
  the only dependency rule, so there is one place that decides what may start.

## Files You'll Touch

| Path                                                    | Role       | Contains                               | Edit or Read |
| ------------------------------------------------------- | ---------- | -------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | Run kinds, alert kinds, validation     | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle  | `reject`, `dispatchNext`, `resume`     | Edit         |
| `factory/watchdog.ts`, `factory/watchdog.test.ts`       | Alerts     | Alert reservation and `notify_user`    | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Projection | Run kind to public status              | Edit         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Escalation, the cap and operator alert | Edit         |

Build order: kind and validation, rejection branch, dispatch rule, alert, resume, projection and
documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat b312722..HEAD -- factory/`             | Revalidate drift, including F003 to F008.       |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `rg -n "run.attempt % 2 === 1" factory/native.ts`       | The escalation rule in `reject`.                |
| `rg -n "async function dispatchNext" factory/native.ts` | The rule that holds the queue.                  |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

## Done when

- [x] The fourth rejection parks the run and keeps the worker's checkpoint.
- [x] An independent ticket starts while a ticket is parked; a dependent one stays queued.
- [x] The operator receives one alert per parked run.
- [x] Owner `resume` with the exact incident continues the same worker.
- [x] The lifecycle table lists `parked` and its exit, and its walking test passes.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

The first escalation still holds the queue while the Foreman decides. That wait is normally
short because the Foreman is an agent; parking covers the case where its decision did not help.
