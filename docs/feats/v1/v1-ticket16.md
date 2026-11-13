# v1-ticket16

## Status

- Goal: show steering delivery and real orchestrator replies in the existing dashboard.
- Initial priority: P1. Effort: Medium. Risk: elevated; UI acknowledgment must not imply action.
- Depends on: v1-ticket13 and v1-ticket15.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F10. Local only; frontend work requires existing-owner coordination.

## Why this matters

Operators must distinguish a queued instruction from a reply and from verified execution.

## Current state

The current pipeline branch focuses on read-only observation. Steering backend is still pending.

## Approach

Add a bounded composer and reply view to the accepted frontend. Preserve client request IDs across
retries and refresh. Render backend delivery outcomes without inventing response correlation. Keep
approvals in Amp and explain when an explicit tool approval is still required.

## Scope

Include frontend steering and existing endpoint consumption. Exclude direct Amp credentials, worker
selectors, arbitrary backend mutations, and approval UI replacement.

## Steps

1. **Compose bounded steering requests**. Retain submission identity through retries and refresh.
2. **Distinguish delivery from replies**. Render uncertain and queued outcomes without success
   fiction.
3. **Verify accessible steering interaction**. Exercise keyboard, narrow widths, and interrupted
   sends.

## Test plan

Render empty conversation, active turn, queued/delivered/uncertain/failed messages, and replies.
Refresh after lost response and confirm no duplicate instruction. Inspect screenshots and a real
pointer/keyboard recording. Verify no credentials or selectable worker destination in browser data.

## Why this approach?

Using the backend's durable request identity prevents UI retry behavior from duplicating steering.

## Files You'll Touch

| Path                     | Role              | Contains                    | Edit or Read                 |
| ------------------------ | ----------------- | --------------------------- | ---------------------------- |
| `web/` after integration | Conversation      | Existing UI and tests       | Edit with owner coordination |
| `factory/dashboard.ts`   | Backend contract  | Accepted steering endpoints | Read                         |
| `factory/README.md`      | Operator contract | Delivery versus execution   | Edit                         |

Inspect the integrated frontend before naming components or extending its tooling.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md` and the merged frontend's browser workflow. No
steering UI checks ran at authoring.

| Command              | Expected result / action                    |
| -------------------- | ------------------------------------------- |
| `git rev-parse HEAD` | Confirm accepted steering backend revision. |
| `git status --short` | Preserve existing frontend owner changes.   |

## Done when

- [ ] Refresh and retries preserve request identity; replies and delivery remain distinct.
- [ ] Required UI states and interactions pass inspected browser checks and full gates.
- [ ] Required independent review passes without broadening action permissions.
