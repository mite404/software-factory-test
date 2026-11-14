# planned-intake-ticket1

## Status

- Goal: persist the whole planned backlog without making draft work dispatchable.
- Initial priority: P0. Effort: Medium.
- Risk: elevated; a planning refresh must never accidentally admit every ticket.
- Depends on: v1-ticket2 and foreman-watchdog-ticket1.
- Planned at: `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14. Local only.

## Why this matters

The live API says zero queued while dozens of units are planned. Adding them to today's queue would
make them eligible for execution without a Foreman scope/admission decision.

## Current state

`tasks` parses authored queue entries; `dispatchNext` treats a missing run with accepted
dependencies as eligible. SQLite already stores ticket JSON. There is no planned/admitted
distinction or public outcome contract. The older inventory's Feature 05 label does not match
backup-adoption-ticket1.

## Approach

Use the existing SQLite tickets table for planned records with canonical dispatch ID, explicitly
public outcome, prerequisites and planned state. Do not parse Markdown or consult Linear at read
time, and do not add another durable backlog store. The Foreman explicitly promotes one scoped
ticket after its accepted prerequisites. Import/refresh is idempotent and cannot promote it.

Preserve accepted records and legacy queue compatibility through the accepted definition/migration
contract. A public outcome must never fall back to the private worker brief. Project planned state
and separate counts through the existing read-only feed; richer event replay stays v1-ticket23.

## Scope

- In: planned records, admission, prerequisite validation, stable IDs and minimal feed projection.
- Out: automatic discovery, bulk dispatch, frontend, rich lifecycle replay or another scheduler.
- Preserve capacity one, original ownership, exact candidate gates and all explicit permissions.

## Steps

1. **Persist canonical planned records**. Store public outcomes and prerequisites without admission.
2. **Require explicit Foreman admission**. Validate prerequisites and preserve migration safety.
3. **Prove planned dispatch refusal**. Exercise refresh, restart, API counts and later promotion.

## Test plan

Drive the real native loop with planned tickets whose prerequisites are already accepted. Assert
zero worker creation before explicit promotion, including after reload and config refresh. Reject
promotion with unmet prerequisites or unauthorized callers. Prove repeat promotion cannot create a
second worker. Use exact IDs across planning, admission and acceptance; preserve old completed runs
and migration behavior. Plant a private-brief canary and verify public outcome/count reads do not
leak it or mutate storage. Only after this acceptance import the full planned v1 inventory.

## Why this approach?

Plan visibility must not grant execution. One durable ticket identity lets planning and running
share a source of truth while an explicit admission boundary protects the native loop.

## Files You'll Touch

| Path                                                    | Role      | Contains                            | Edit or Read |
| ------------------------------------------------------- | --------- | ----------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records   | Planned/admitted ticket identity    | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Admission | Parsing, dependencies and dispatch  | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Controls  | Authorized promotion and projection | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Feed      | Planned state, outcomes and counts  | Edit         |
| `factory/README.md`                                     | Contract  | Planning versus execution           | Edit         |

Build durable records and dispatch refusal before controls and projection. Reuse current modules;
there is no factory/core.ts at planning time. Do not create it merely to follow a proposed filename.

## Initial state / preflight

Run shared preflight in `docs/v1-execution.md`; authoring did not run implementation checks.

| Command                                                 | Expected result / action                          |
| ------------------------------------------------------- | ------------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Confirm definition and notice prerequisites.      |
| `git diff --stat 2c00930..HEAD -- factory/`             | Inspect accepted admission and storage contracts. |
| `git diff -- factory/ && git diff --cached -- factory/` | Explain existing edits.                           |

## Done when

- [ ] Planned work is visible under canonical IDs but cannot dispatch before Foreman admission.
- [ ] Refresh/reload, accepted prerequisites and migration cannot silently grant admission.
- [ ] Minimal read-only feed distinguishes planned, queued and accepted without private briefs.
- [ ] Full gates, guard and fresh cold review pass before the coordinator imports all draft units.
