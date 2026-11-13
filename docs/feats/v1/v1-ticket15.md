# v1-ticket15

## Status

- Goal: send ordered steering messages to the one configured orchestrator without duplicate append.
- Initial priority: P1. Effort: Medium. Risk: elevated; ambiguous delivery can repeat instructions.
- Depends on: v1-ticket2 and v1-ticket4.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F10. Local only; pending configuration and evidence acceptance.

## Why this matters

Operator steering needs durable delivery status, not a browser-held credential or arbitrary thread
ID.

## Current state

There is no steering endpoint. The factory has a configured coordinator and supported native APIs.

## Approach

Protect bounded POST requests with authentication, origin checks, and authorization. Persist client
request ID and ordered delivery outcome before native append. Reconcile uncertain appends using
supported semantics. Read replies server-side without treating acknowledgment as completion.

## Scope

Include durable request/delivery/reply backend. Exclude arbitrary thread picker, worker messaging,
remote shell, implicit permission changes, and frontend authoring.

## Steps

1. **Validate one orchestrator destination**. Reject browser-selected threads and oversized
   messages.
2. **Persist ordered steering delivery**. Deduplicate requests and reconcile uncertain native
   appends.
3. **Read replies without inference**. Distinguish accepted delivery, model response, and completed
   work.

## Test plan

Use real HTTP/SQLite with a controlled native API boundary, then one small authorized TEST thread.
Send during an active turn, lose an append response, restart, and duplicate IDs. Prove tested order
and no blind reappend. Reject cross-origin requests and credential-bearing output.

## Why this approach?

Durable client identity makes a lost HTTP response recoverable without repeating the instruction.

## Files You'll Touch

| Path                                                    | Role        | Contains                        | Edit or Read |
| ------------------------------------------------------- | ----------- | ------------------------------- | ------------ |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | HTTP        | Steering command and reads      | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Amp adapter | Supported message/reply APIs    | Edit         |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Delivery    | Request identities and outcomes | Edit         |
| `factory/README.md`                                     | Contract    | Ordering and uncertain delivery | Edit         |

Discover native ordering and reconciliation semantics before persisting a claimed guarantee.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`. No native message test ran at authoring.

| Command                                     | Expected result / action                                |
| ------------------------------------------- | ------------------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm configuration and protected action conventions. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate API and ownership changes.                   |

## Done when

- [ ] One authorized destination, durable deduplication, and tested ordering survive lost responses.
- [ ] Delivery and reply remain distinct; tool approval and action permissions stay explicit.
- [ ] Full gates and independent cold review pass.
