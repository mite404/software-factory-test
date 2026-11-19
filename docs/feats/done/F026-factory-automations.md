# F026-factory-automations

## Status

- Goal: the Foreman can list, turn on, turn off and run named factory automations with one
  control call, without editing code or Amp schedules by hand.
- Outcome: Automations switch on, off and run on demand
- Initial priority: P2. Effort: Medium.
- Risk: elevated; an automation sends a prompt on a timer, so a wrong due check repeats prompts
  and spends tokens. An automation must never start, admit or resume work by itself.
- Depends on: F025-config-directory, for `factory/config/automations/`.
- Planned at: `0ccad909da953187ec58ca6011965b9e7db3cceb`, 2026-11-15. Local only.

## Why this matters

The operator wants scheduled prompts (such as a codebase pulse or a weekly failure audit) that
can be switched on and off and fired on demand, the way Amp's own scheduled prompts work, but
owned by the factory. Today the only timer is the watchdog: three numbers in the definition and
a prompt hard-coded in `factory/watchdog.ts`. Adding a second timed job means changing code.

## Current state

- `factory/watchdog.ts` owns the factory's one Amp schedule through `amp.set_schedule`,
  `amp.get_schedule` and `amp.clear_schedule` on the owner thread. It refuses to touch an
  unrelated schedule on that thread, so a thread holds one schedule.
- The watchdog wake runs every 30 minutes and sends its prompt to the owner thread.
- The control tool in `factory/plugin.ts` has owner-only actions (`admit`, `resume`,
  `record-merge`) that reuse one owner check.
- `factory/persistence.ts` keeps durable state in SQLite (`coordinator`, `runs`, `events`,
  `monitor`).

## Approach

One clock, many automations. Keep the factory's single Amp schedule and make each wake check
which declared automations are due. No automation gets its own Amp schedule.

```text
factory/config/automations/<name>/automation.md
  front matter: schedule (5-field cron, UTC), enabled (default false)
  body: the prompt sent to the Foreman thread when it fires
```

- The schedule's interval becomes the shortest interval any enabled automation needs, with the
  watchdog's 30 minutes as the longest. Changing it goes through the existing watchdog
  reconcile, so its conflict and unknown-outcome handling still apply.
- Durable per-automation state in SQLite: `enabled` override, `lastRunAt`, `lastOutcome`
  (`sent`, `unknown`, `skipped`). The authored `enabled` is the default; the control override wins
  until the next explicit reload changes the authored value.
- A run sends the body to the Foreman thread, prefixed with the automation name. A send with an
  unknown outcome is recorded `unknown` and not retried on the next wake.
- Due check: run when the last cron time at or before now is later than `lastRunAt`. Missed
  wakes collapse into one run, never a burst.
- The watchdog becomes the first automation in code only; its prompt and thresholds stay where
  they are until a later ticket moves them.

New owner-only control actions, using the existing owner check:

| Action               | Input  | Effect                                    |
| -------------------- | ------ | ----------------------------------------- |
| `automations`        | none   | List name, schedule, enabled, last run    |
| `automation-enable`  | `name` | Set the override on; reconcile the clock  |
| `automation-disable` | `name` | Set the override off; reconcile the clock |
| `automation-run`     | `name` | Send now, enabled or not; record the run  |

## Scope

- In: the automation file schema, the due check, durable state, the four actions, clock
  interval reconcile, tests and README.
- Out: dashboard buttons (F027), editing an automation's prompt or schedule from a control
  call (edit the file and reload), and webhooks or other triggers.
- Out: an automation that creates threads, admits, resumes or starts work. It only sends text.
- Preserve: the watchdog's behaviour, prompt and schedule ownership rules.

## Steps

1. **Declare automation files**. Add the `automation.md` schema to the F025 loader, rejecting
   unknown keys, a bad cron and an empty body.
2. **Check due automations**. On each connected owner wake, run every enabled automation whose
   last cron time is after its `lastRunAt`, and record the outcome.
3. **Fit the clock interval**. Set the factory schedule to the shortest interval enabled
   automations need, capped at 30 minutes, through the watchdog reconcile.
4. **Add control actions**. Add `automations`, `automation-enable`, `automation-disable` and
   `automation-run` as owner-only actions on the control tool.
5. **Document automations**. Describe the file, the actions, the one-clock rule and the
   unknown-send rule in the README.

## Test plan

- A cron of every 5 minutes with wakes at 0, 5 and 25 minutes runs at 0, 5 and once at 25, not
  four times at 25.
- A disabled automation never runs on a wake; `automation-run` still sends it once.
- A send that throws is recorded `unknown` and not sent again on the next wake.
- A non-owner calling any of the four actions is refused, and state is unchanged.
- Enabling a 5-minute automation shortens the schedule; disabling it restores 30 minutes; an
  unrelated schedule on the thread is still refused.
- No automation run changes any ticket's run record.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: each new timed job is a code change, and a second Amp schedule on the owner thread
  is refused by design.
- This buys: one clock with one owner, so schedule conflicts stay impossible; automations are
  files, so their prompts are versioned and reviewed like any other config.

## Files You'll Touch

| Path                       | Role              | Contains                           | Edit or Read |
| -------------------------- | ----------------- | ---------------------------------- | ------------ |
| `factory/native.ts`        | Loader            | Automation files in the definition | Edit         |
| `factory/watchdog.ts`      | Clock             | Interval reconcile, due check      | Edit         |
| `factory/persistence.ts`   | Durable state     | Per-automation state               | Edit         |
| `factory/plugin.ts`        | Control tool      | The four owner-only actions        | Edit         |
| `factory/watchdog.test.ts` | Clock proof       | Due, collapse, interval, unknown   | Edit         |
| `factory/plugin.test.ts`   | Action proof      | Owner check, run, enable, disable  | Edit         |
| `factory/README.md`        | Operator contract | Automations section                | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record it; explain differences from the planning SHA. |
| `git status --short`                        | Clean, or every edit accounted for.                   |
| `ls factory/config`                         | Present; F025 has landed.                             |
| `bun test factory`                          | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`      | No errors.                                            |
| `bun run format:check && bun run fallow:ci` | Pass.                                                 |
| `bash factory/checks.sh guard`              | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [x] A declared automation runs on schedule through the factory's one Amp schedule.
- [x] The Foreman lists, enables, disables and runs automations with control calls only.
- [x] Missed wakes produce one run, and an unknown send is never repeated automatically.
- [x] Non-owner calls are refused and no automation touches a ticket's run.
- [x] Full gates, guard and a fresh cold review pass on the accepted revision.
