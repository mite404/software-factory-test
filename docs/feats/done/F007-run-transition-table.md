# F007-run-transition-table

## Status

- Goal: declare the run lifecycle in one table so every stop has a visible, tested exit.
- Initial priority: P1. Effort: Medium.
- Risk: elevated; the table replaces the scattered rules that decide every stop and recovery.
- Depends on: F003, F004, F005 and F006, so their new stops and recoveries enter the table once
  instead of being moved twice.
- Planned at: `529eb311f790d87de3ad204b07add5e7e077d5ce`, 2026-11-14. Local only.

## Why this matters

On 2026-11-14 a run parked in `creating` and no control action could move it. The queue stopped
until the Foreman wrote `retry-create`. Nobody could have seen the missing exit by reading the
code, because the rules for one run kind are spread over several functions. The operator compared
the factory with a job runner whose error exits are listed at the top of one file, and approved
taking that idea.

## Current state

- `factory/persistence.ts` declares seven run kinds: `preparing`, `preparation-failed`,
  `creating`, `running`, `blocked`, `uncertain` and `done`. It also lists the allowed incident
  reasons and the recovery values `resume`, `retry-setup` and `inspect`.
- `factory/native.ts` decides stops in three places: `stoppedRun` maps `blocked`,
  `preparation-failed` and `uncertain` to a reason and recovery; `interruptedRun` maps `creating`,
  `preparing` and in-flight deliveries to a reason; `activityReasons` maps an observed thread
  state to `worker-error` or `approval-required`.
- Which control action may leave which kind is checked inline: `retryAdmission`, `resumeRepair`,
  `retryCreate`, and an early return while any run is `creating`, `uncertain` or in preparation.
- `factory/plugin.ts` lists the control actions separately in `controlActions`.
- `inspect` names no action. A run whose only recovery is `inspect` can be left by nothing the
  factory offers, which is what happened to `creating`.
- No test states that every non-terminal kind can be left.

## Approach

Add one declared table: for each run kind, the stops it can enter, each stop's reason and
recovery, and the control action or observed event that leaves it. Derive `stoppedRun`,
`interruptedRun`, the activity mapping and the per-action admission checks from the table instead
of repeating its facts. Behavior does not change; a kind that today has no exit is listed as
such, by name, with the reason it is safe.

Add one test that walks the table: every kind except `done` has at least one exit, every recovery
value names a control action that exists or is on an explicit list of Foreman-only stops, and
every reason in the table is an allowed reason in persistence.

Print the table from factory control `status` as a compact read-only section, so the Foreman and
the dashboard can show it later. No drawing is part of this ticket.

## Scope

- In: the table, deriving the existing stop and admission rules from it, the exit test, the
  read-only projection, README and foreman.md.
- Out: any new stop, recovery or control action. If the test finds a kind with no exit, record it
  on the explicit list and report it; do not invent an exit.
- Out: the per-step pipeline inside a run, a visual editor, and dashboard or frontend work.
- Preserve: every existing test passes unchanged, and saved state opens unchanged.

## Steps

1. **Declare the lifecycle table**. Write the run kinds with their stops, reasons, recoveries and
   exits as one typed constant next to the run types.
2. **Derive the stop rules**. Replace the bodies of the stop and interruption mappings and the
   activity mapping with lookups in the table, keeping their results identical.
3. **Derive action admission**. Route each control action's check of which kinds it may leave
   through the table, keeping every current refusal and message.
4. **Prove every kind exits**. Add the walking test, and list by name any stop that only the
   Foreman can end.
5. **Project and document it**. Add the read-only table to status and describe it once in the
   README, removing prose that now repeats it.

## Test plan

Existing tests are the behavior check and must pass unchanged. Add the walking test described
above, with its expected set of exitless stops written in the test, not read from the table.
Prove the test can fail: remove one exit from the table locally, see it fail, and restore it;
say so in the report. Cover that status includes the table without private briefs or report
paths.

## Why this approach?

- Without it: each new stop adds rules in three functions and nobody can see whether it has a way
  out until a run is stuck in it live.
- This buys: one place to read where every error leads, and a test that fails when a stop is added
  without an exit. Deriving the rules from the table means the table cannot drift from behavior.

## Files You'll Touch

| Path                                          | Role       | Contains                                | Edit or Read |
| --------------------------------------------- | ---------- | --------------------------------------- | ------------ |
| `factory/persistence.ts`                      | Records    | Run kinds, incident reasons, recoveries | Edit         |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle  | Stop mappings and admission checks      | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts` | Adapter    | `controlActions`, status result         | Edit         |
| `factory/persistence.test.ts`                 | Tests      | Allowed reasons and recoveries          | Edit         |
| `factory/README.md`, `factory/foreman.md`     | Operations | Stops and recovery actions              | Edit         |

Build order: table, stop rules, admission, test, projection and documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                   | Expected result / action                       |
| --------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`                | Record the dispatch revision; clean tree.      |
| `git diff --stat 529eb31..HEAD -- factory/`               | Revalidate drift, including F003 to F006.      |
| `git diff -- factory/ && git diff --cached -- factory/`   | Preserve unrelated changes.                    |
| `rg -n "function stoppedRun\|function interruptedRun"`    | The two stop mappings in `factory/native.ts`.  |
| `rg -n "provider-limit\|handoff\|providerLimit" factory/` | Present; F003, F005 and F006 accepted first.   |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`            | Passes; CI runners have no global Git identity |

## Done when

- [x] One table lists every run kind with its stops, recoveries and exits.
- [x] The stop and admission rules read from it, and all existing tests pass unchanged.
- [x] A test fails when a non-terminal kind or stop has no exit and is not on the named list.
- [x] Status shows the table without private data.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

The idea comes from a public description of a state-machine job runner; the Foreman saw
screenshots only, not its code. Nothing here depends on that tool.
