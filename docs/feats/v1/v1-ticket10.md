# v1-ticket10

## Status

- Goal: recover supported executor disconnections without replacing the worker.
- Initial priority: P0. Effort: Medium. Risk: elevated; blind resume can duplicate active work.
- Depends on: v1-ticket2.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F03. Local only; pending definition acceptance.

## Why this matters

Observation reattachment alone did not restore tools for several real dogfood worker outages.

## Current state

The plugin observes native thread state. Earlier workers required authorized finite CLI
continuation; the origin of the coordinator SIGTERM remains unverified.

## Approach

Discover supported executor-reconnect semantics, then record bounded recovery attempts and their
outcomes. Reconcile activity, pending messages, and verification before any continuation. Preserve
thread, model, worktree, ticket attempt, and repair ownership. Unsupported recovery stays blocked.

## Scope

Include observation reattachment and supported reconnection. Exclude parsing assistant prose,
replacing workers, unbounded retries, silently changing providers, and relabeling real outages TEST.

## Steps

1. **Discover supported reconnect behavior**. Separate unavailable observation from disconnected
   tools.
2. **Reconcile before worker continuation**. Respect pending messages and in-flight verification.
3. **Prove bounded owner recovery**. Label intentional fixture prompts and titles TEST.

## Test plan

Use one cheap TEST fixture for intentional disconnect/reconnect. Exercise duplicate wakeups, working
versus unknown states, a pending repair message, coordinator restart, and failed recovery. Assert no
duplicate append, worker, code attempt, or acceptance. Record unsupported cases honestly.

## Why this approach?

A known idle state is not evidence that restarting execution is safe or that work is accepted.

## Files You'll Touch

| Path                                          | Role           | Contains                               | Edit or Read |
| --------------------------------------------- | -------------- | -------------------------------------- | ------------ |
| `factory/plugin.ts`, `factory/plugin.test.ts` | Native adapter | Observations and recovery              | Edit         |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle      | Pending actions and owner retention    | Edit         |
| `factory/persistence.ts`                      | History        | Recovery attempts                      | Edit         |
| `factory/foreman.md`, `factory/README.md`     | Policy         | TEST labeling and bounded intervention | Edit         |

Inspect API capability before implementing recovery actions.

## Initial state / preflight

Run the common preflight in `docs/v1-execution.md`. No intentional disconnect was run at authoring.

| Command                                     | Expected result / action                       |
| ------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD`                        | Record native SDK and definition versions.     |
| `git diff --stat 62816cf..HEAD -- factory/` | Review accepted recovery and escalation paths. |

## Done when

- [ ] Supported reconnection retains ownership and cannot duplicate pending work.
- [ ] Unsupported states block visibly; intentional tests are labeled and real outages are not.
- [ ] Full gates and fresh cold review pass.
