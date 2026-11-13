# v1-ticket9

## Status

- Goal: return exact worker code and evidence across separate orbs before integration.
- Initial priority: P0. Effort: Medium. Risk: elevated; wrong transfer can land untested code.
- Depends on: v1-ticket4 and v1-ticket8.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F03. Local only; pending evidence and ownership acceptance.

## Why this matters

The accepted native steel thread shares local worktrees; it does not prove remote worker delivery.

## Current state

`NativeHost` and plugin dispatch use local worker worktrees. Exact-candidate integration and
original-worker correction are implemented locally. A commit SHA alone does not transfer objects.

## Approach

Use supported Amp file/change transfer and native threads to exchange scoped source and artifacts.
Verify project, base, candidate revision, content, and required evidence before forming the current
integration candidate. Keep the same remote worker for rejection and repair.

## Scope

Include remote execution selection and exact artifact transfer. Exclude application pushes, implicit
credential sharing, arbitrary filesystem export, and acceptance based only on worker prose.

## Steps

1. **Transfer scoped worker inputs**. Supply exact base and public instructions without private
   state.
2. **Verify returned candidate artifacts**. Reject mismatched identity, incomplete objects, and
   stale proof.
3. **Repair with original worker**. Re-form and gate the candidate against current integration.

## Test plan

Use independent Git directories first, then a cheap Luna separate-orb fixture. Reject missing
objects, wrong bases, stale reports, and lost transfers. Advance main after proof and rerun the full
gate. Duplicate delivery must not duplicate claims, workers, or landings.

## Why this approach?

Transferred code and preserved artifacts let the integrator verify the artifact it actually lands.

## Files You'll Touch

| Path                                          | Role         | Contains                             | Edit or Read |
| --------------------------------------------- | ------------ | ------------------------------------ | ------------ |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle    | Remote preparation and acceptance    | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts` | Amp boundary | Supported transfer calls             | Edit         |
| `factory/persistence.ts`                      | Identity     | Transfer receipts and original owner | Edit         |
| `factory/README.md`                           | Contract     | Separate-orb limitations and setup   | Edit         |

Discover exact transfer APIs before selecting adapters or new modules.

## Initial state / preflight

Execute the common preflight in `docs/v1-execution.md`; no cross-orb trial ran at authoring.

| Command                                     | Expected result / action                           |
| ------------------------------------------- | -------------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm accepted evidence and ownership contracts. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect native host and staging drift.             |

## Done when

- [ ] A separate worker orb returns exact code and preserved revision-bound evidence.
- [ ] Rejection retains its original owner; stale transfer cannot release dependents.
- [ ] Full gates and independent review pass with local and native proof distinguished.
