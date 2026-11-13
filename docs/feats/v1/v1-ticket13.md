# v1-ticket13

## Status

- Goal: finish the workbench against actual lifecycle and inspectable evidence.
- Initial priority: P1. Effort: Medium. Risk: elevated; misleading activity hides blocked work.
- Depends on: v1-ticket23 and acceptance of the pipeline-view branch integration.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F08. Local only; frontend owned by the existing pipeline-view thread.

## Why this matters

The current frontend has tested labeled fixtures and connected to real accepted work, but has not
yet observed a new live landing, rejection, or repair transition.

## Current state

The frontend thread's unpushed merge `dc3dfe8` includes backend commits through `62816cf`. Its live
read-only relay observes six accepted dogfood tasks. No frontend code is in this parent.

## Approach

Integrate the exact frontend commits after combined gates, then show evidence through curated
backend reads. Distinguish actual active observations, recorded acceptance, pending review, missing
review evidence, stale state, and explicit samples.

## Scope

Include existing frontend files, evidence UI, and response compatibility. Exclude redesign, invented
progress, worker connections, mutation endpoints, and concurrent edits by a new worker.

## Steps

1. **Integrate exact frontend history**. Preserve both branches and rerun combined project gates.
2. **Show recorded evidence honestly**. Display real identities without treating missing proof as
   pass.
3. **Observe actual worker transitions**. Capture a newly recorded event without data copying.

## Test plan

Exercise narrow widths, keyboard access, long labels, empty queue, stale/error states, review
required and no-recorded-review routes, and reduced motion. Inspect screenshots and pointer/keyboard
recordings. Keep fixture-only states labeled. Verify HTTP reads trigger no model or worker calls.

## Why this approach?

A live endpoint plus a newly observed event proves connection; copied state proves only rendering.

## Files You'll Touch

| Path                       | Role      | Contains                            | Edit or Read           |
| -------------------------- | --------- | ----------------------------------- | ---------------------- |
| `web/` in frontend branch  | Workbench | Existing UI and tests               | Edit by existing owner |
| `package.json`, `bun.lock` | Tooling   | Existing combined frontend scripts  | Edit after merge       |
| `factory/dashboard.ts`     | Feed      | Curated evidence API                | Read                   |
| `factory/README.md`        | Operation | Live source and sample distinctions | Edit                   |

Inspect the merged frontend's actual files before allocating edit scope.

## Initial state / preflight

Run common preflight from `docs/v1-execution.md` plus frontend scripts after merge. No additional
browser verification is claimed by authoring this ticket.

| Command              | Expected result / action                          |
| -------------------- | ------------------------------------------------- |
| `git rev-parse HEAD` | Record actual combined frontend/backend revision. |
| `git status --short` | Preserve the frontend owner's work before merge.  |

## Done when

- [ ] Combined history passes gates and the UI observes a new actual factory event.
- [ ] Evidence, freshness, accessibility, and motion states pass inspected browser checks.
- [ ] Required independent review passes without claiming fixture-only transitions were live.
