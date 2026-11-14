# v1-ticket13

## Status

- Goal: finish the workbench against actual lifecycle and inspectable evidence.
- Initial priority: P1. Effort: Medium. Risk: elevated; misleading activity hides blocked work.
- Depends on: v1-ticket23. Pipeline-view branch integration is merged.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F08. Remaining evidence, lifecycle, accessibility, and motion acceptance only.

## Why this matters

The current frontend has tested labeled fixtures and connected to real accepted work, but has not
yet observed a new live landing, rejection, or repair transition.

## Current state

The frontend and same-origin API are merged through PR #3, with 140 combined tests and successful
CI. Live reads, safe titles, freshness, status colors, review waiting/release animation, and reduced
motion are implemented. Fixture captures do not replace actual-transition acceptance.

## Approach

Show evidence through curated backend reads. Distinguish actual active observations, recorded
acceptance, pending review, missing review evidence, stale state, and explicit samples.

## Scope

Include existing frontend files, evidence UI, and response compatibility. Exclude redesign, invented
progress, worker connections, mutation endpoints, and concurrent edits by a new worker.

## Steps

1. **Show recorded evidence honestly**. Display real identities without treating missing proof as
   pass.
2. **Complete operator controls**. Add a motion toggle and verify keyboard and evidence access.
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
| `web/`                    | Workbench | Existing UI and tests               | Edit                   |
| `package.json`, `bun.lock` | Tooling   | Existing combined frontend scripts  | Read                   |
| `factory/dashboard.ts`     | Feed      | Curated evidence API                | Read                   |
| `factory/README.md`        | Operation | Live source and sample distinctions | Edit                   |

Inspect the merged frontend's actual files before allocating edit scope.

## Initial state / preflight

Run common preflight from `docs/v1-execution.md` plus frontend scripts. No additional browser
verification is claimed by authoring this ticket.

| Command              | Expected result / action                          |
| -------------------- | ------------------------------------------------- |
| `git rev-parse HEAD` | Record actual combined frontend/backend revision. |
| `git status --short` | Preserve unrelated frontend work.                 |

## Done when

- [ ] Combined history passes gates and the UI observes a new actual factory event.
- [ ] Evidence, freshness, accessibility, and motion states pass inspected browser checks.
- [ ] Required independent review passes without claiming fixture-only transitions were live.
