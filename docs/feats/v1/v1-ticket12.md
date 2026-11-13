# v1-ticket12

## Status

- Goal: execute supported native hooks once under existing permissions and lifecycle rules.
- Initial priority: P0. Effort: Medium. Risk: elevated; hooks can repeat privileged side effects.
- Depends on: v1-ticket11.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F12. Local only; pending capability acceptance.

## Why this matters

Project-specific hooks must not become an alternate route around acceptance or ownership.

## Current state

Native lifecycle events reach the plugin. Project-owned declarative hook execution is absent.

## Approach

Resolve hooks from the accepted definition. Validate supported event identity and explicit action
inputs, enforce timeout and permissions, and persist claims/outcomes before visible events.
Reconcile interrupted or ambiguous effects rather than replaying blindly.

## Scope

Include bounded supported local actions and duplicate protection. Exclude arbitrary browser
commands, provider-specific hooks, secret access grants, and automatically running hooks on setup.

## Steps

1. **Validate native hook declarations**. Reject unsupported events, inputs, and capabilities.
2. **Persist bounded hook attempts**. Claim once, execute with timeout, and record outcomes.
3. **Prove safe replay refusal**. Duplicate and interrupted events cannot repeat uncertain effects.

## Test plan

Use real local fixture commands with visible effect counters. Repeat events across restart,
interrupt execution, deny permission, and exceed timeout. Validate that install/read/refresh run no
commands and a hook cannot accept a stale candidate or replace its owner.

## Why this approach?

Lifecycle-owned claims keep extensibility inside the same safety rules as native actions.

## Files You'll Touch

| Path                                                    | Role             | Contains                        | Edit or Read |
| ------------------------------------------------------- | ---------------- | ------------------------------- | ------------ |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Events           | Native delivery                 | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Actions          | Permission and timeout boundary | Edit         |
| `factory/persistence.ts`, `factory/persistence.test.ts` | History          | Claims and outcomes             | Edit         |
| `factory/setup-factory.ts`, `factory/README.md`         | Install contract | Validation without execution    | Edit         |

Build durable claims before execution. Reuse accepted definition schemas.

## Initial state / preflight

Run common preflight in `docs/v1-execution.md`. Hook tests were not run at authoring.

| Command                                     | Expected result / action                  |
| ------------------------------------------- | ----------------------------------------- |
| `git rev-parse HEAD`                        | Record accepted capability configuration. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect lifecycle and permission changes. |

## Done when

- [ ] Duplicate events do not repeat effects, and interrupted attempts retain visible uncertainty.
- [ ] Unauthorized hooks fail without bypassing ownership, acceptance, or setup safety.
- [ ] Full gates and required independent review pass.
