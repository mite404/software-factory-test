# F029-gate-check-files

## Status

- Goal: the factory gate runs each check from its own file, records a result per check, and fails
  only on a required check, so a worker hears about every failure in one round trip.
- Outcome: The gate reports every check on its own
- Initial priority: P1. Effort: Medium.
- Risk: elevated; the gate decides acceptance. A required check that is skipped, misread or
  missing must fail the gate, never pass it.
- Depends on: F025-config-directory. Delivers the check-execution part of v1-ticket11; tool
  discovery and CI evidence stay there.
- Planned at: `0ccad909da953187ec58ca6011965b9e7db3cceb`, 2026-11-15. Local only.

## Why this matters

The dogfood gate is one `verify` string chaining eight commands with `&&`. The first failure
hides the rest, so a worker fixes one check and fails the next, costing a round trip each time.
One exit code means the factory cannot say which check failed except by reading log text, so the
dashboard's check ticks are drawn on a timer. All eight share one 600 000 ms budget, nothing can
be advisory, and a flaky test reruns everything.

## Current state

- `verify` in `factory/native.ts` runs the definition's `verify` string once under
  `bash -lc` with a fixed `timeout = 600_000`, returning one status plus stdout and stderr.
- Callers: candidate gating (`verify(run.worktree, pinned.verify)`) and the repair path.
- F008 already keeps separate stdout and stderr tails in the rejection feedback.
- The dashboard draws verify chips from a fixed list, not results.

## Approach

```text
factory/config/checks/<name>.yaml
  command:   bun run lint:ci
  required:  true            # false = advisory
  timeoutMs: 120000          # optional, default 600000
  order:     20              # run order; ties by name
```

- When `checks/` exists, the gate runs every check in order, each with its own timeout, and
  records `{name, required, status, durationMs, outputTail}` per check. It continues after a
  failure so every result is known.
- The gate passes when every required check exits 0. An advisory failure is reported to the
  worker and in evidence, but does not reject.
- A `checks/` directory with no required check is refused at load: that gate could never fail.
- The flat `verify` string stays valid for projects without `checks/`, as one required check
  named `verify`. Both together is a conflict.
- Rejection feedback lists each failed check with its own tail, reusing F008's tail budget split
  across failed checks.
- The public feed gains per-check names and pass, fail or timeout; no output. The dashboard's
  verify chips read these instead of a timer.

## Scope

- In: the check file schema, sequential per-check execution, per-check evidence, feedback, the
  feed field, the dashboard chips, migrating the dogfood `verify` into eight files (Foreman, after
  landing), tests and README.
- Out: running checks in parallel (the orb has two CPUs), retrying flaky checks (F019), tool
  discovery and CI evidence (v1-ticket11).
- Preserve: projects with only `verify` gate exactly as today.

## Steps

1. **Declare check files**. Add the check schema to the F025 loader, refusing unknown keys, a
   directory with no required check, and `checks/` beside `verify`.
2. **Run every check**. Run checks in order with their own timeouts, continuing after failures,
   and record one result per check.
3. **Decide on required checks**. Pass only when every required check exits 0; report advisory
   failures without rejecting.
4. **Feed back per check**. Send the worker each failed check with its own output tail.
5. **Publish check results**. Add per-check status to the feed and drive the dashboard chips from
   it.
6. **Document check files**. Describe the file, the pass rule and the flat-file fallback in the
   README.

## Test plan

- Three checks where the first and third fail: both failures appear in one rejection, and the
  second's pass is recorded.
- An advisory failure with all required checks passing is accepted, and its failure is in
  evidence.
- A check that exceeds its own timeout is a failure named `timeout`, and later checks still run.
- A project with only `verify` produces the same accept and reject decisions as before on the
  existing gate fixtures.
- The feed carries names and statuses only: plant a canary in a check's output.
- Dashboard screenshot with one failed and one advisory chip.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: one exit code hides every failure after the first and every check's own time,
  which is where most repair round trips and the fake dashboard ticks come from.
- This buys: the gate owns a list of named results, so acceptance, feedback and the dashboard all
  read the same record, and the flat command remains a one-check special case.

## Files You'll Touch

| Path                        | Role              | Contains                             | Edit or Read |
| --------------------------- | ----------------- | ------------------------------------ | ------------ |
| `factory/native.ts`         | Gate              | `verify`, its callers, check loading | Edit         |
| `factory/native.test.ts`    | Gate proof        | Multi-failure, advisory, timeout     | Edit         |
| `factory/dashboard.ts`      | Feed              | Per-check status                     | Edit         |
| `factory/dashboard.test.ts` | Feed proof        | Canary, statuses                     | Edit         |
| `web/`                      | Kit page          | Verify chips from results            | Edit         |
| `factory/README.md`         | Operator contract | Check files, pass rule               | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record it; explain differences from the planning SHA. |
| `git status --short`                        | Clean, or every edit accounted for.                   |
| `ls factory/config`                         | Present; F025 has landed.                             |
| `rg -n "function verify" factory/native.ts` | Revalidate the gate and its callers.                  |
| `bun test factory`                          | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`      | No errors.                                            |
| `bun run format:check && bun run fallow:ci` | Pass.                                                 |
| `bash factory/checks.sh guard`              | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] Every check runs and is recorded even after an earlier one fails.
- [ ] Only required checks decide acceptance; advisory failures are reported, not rejected.
- [ ] The worker gets each failed check's own output in one rejection.
- [ ] The dashboard chips show real per-check results.
- [ ] A project with only `verify` gates exactly as before.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
