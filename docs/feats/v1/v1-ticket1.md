# v1-ticket1

## Status

- Goal: exclude private ticket briefs from public dashboard titles.
- Initial priority: P0. Effort: Small.
- Risk: elevated; public status crosses the private briefing boundary.
- Depends on: accepted observation API and step-label contracts.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Mode: local only. Backlog: F07. State: accepted natively and verified in the parent.
- Accepted candidate: `af0ae26e10a7069d0b440b190203a74c34fc2de9`, attempt one.
- Proof: 127 tests, all configured gates and guard; fresh cold review passed with no findings.

## Why this matters

The connected frontend observed a 649-character feature-06 title containing its worker brief. Status
must not publish instructions intended only for the assigned worker.

## Current state

`publish` in `factory/plugin.ts` uses `task.brief` for queued titles, failed title lookup, and
review projection. `applyObservation` in `factory/dashboard.ts` trusts matching observed titles. The
durable fallback already uses the ticket ID. Old observation files can survive a refresh.

## Approach

Make public titles independent of private briefs at both production and HTTP projection. Use the
ticket ID when no explicitly public safe title exists. Do not infer safety from text length.
Preserve the response shape, thread identity, steps, freshness, and revision-bound evidence.

## Scope

Edit `factory/` only. Exclude frontend, coordinator queue and permissions, new title configuration,
and destructive rewriting of private historical state. Do not truncate a brief and call it safe.

## Steps

1. **Reproduce public brief disclosure**. Seed a private canary through the real plugin and HTTP.
2. **Separate titles from briefs**. Remove unsafe fallback and reject legacy disclosure at read
   time.
3. **Verify every title state**. Cover queued, unavailable lookup, accepted, and pending review.

## Test plan

Use a real temporary Git repo and persisted state. Assert the private canary is absent from the
entire HTTP response for fresh and stale legacy observations, including matching identities. Check
the plugin never emits it, that reads preserve state, and that evidence remains accurate. Keep a
meaningful public ticket identifier. Run the complete shared gate and cold review.

## Why this approach?

Fixing only the producer leaves legacy observations readable. A ticket-ID fallback keeps public
identity useful without attempting to sanitize arbitrary private instructions.

## Files You'll Touch

| Path                                                  | Role             | Contains                      | Edit or Read |
| ----------------------------------------------------- | ---------------- | ----------------------------- | ------------ |
| `factory/plugin.ts`                                   | Producer         | Snapshot titles               | Edit         |
| `factory/dashboard.ts`                                | Public boundary  | Legacy observation projection | Edit         |
| `factory/plugin.test.ts`, `factory/dashboard.test.ts` | Proof            | Producer and HTTP canaries    | Edit         |
| `factory/README.md`                                   | Contract         | Public-title policy           | Edit         |
| `factory/persistence.ts`                              | Durable identity | Task and run shapes           | Read         |

Build the failing HTTP case first, then producer and projection fixes. No new state store.

## Initial state / preflight

Run the full [dispatch preflight](../../v1-execution.md#dispatch-preflight) in the prepared
worktree. Checks are not run during authoring.

| Command                                     | Expected result / action         |
| ------------------------------------------- | -------------------------------- |
| `git rev-parse HEAD`                        | Record actual dispatch revision. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate changed title paths.  |

## Done when

- [x] No private brief canary reaches snapshot titles or HTTP, including legacy observations.
- [x] Public identity, current review evidence, steps, and stale-state behavior remain correct.
- [x] Full gates, guard, and required fresh cold review pass on the clean exact candidate.
