# v1-ticket11

## Status

- Goal: use declared project verification tools without replacing or double-running them.
- Initial priority: P0. Effort: Medium. Risk: elevated; missing mandatory checks cannot look green.
- Depends on: v1-ticket2.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F12. Local only; pending definition acceptance.

## Why this matters

A generic command does not describe which harness, version, or coverage proved an exact revision.

## Current state

The native factory runs configured setup and verification commands; `checks.sh` has project stages.
Installed action-checks, verification CLI, formal tools, and ci-watch must be discovered.

## Approach

Extend the accepted definition's required/advisory capability declarations. Discover and reuse
existing tools; record command identity, version, coverage, revision, and evidence for each result.
Missing required tools block; advisory feedback never overrides mandatory failure.

## Scope

Include gate resolution and evidence contracts. Exclude replacing installed tools, inventing a
formal model without a suitable property, CI reruns on dashboard reads, and a second watcher.

## Steps

1. **Resolve declared verification capabilities**. Discover actual installed commands and contracts.
2. **Bind checks to revisions**. Preserve required/advisory roles and declared coverage.
3. **Reject missing mandatory tools**. Prove a stale or advisory pass cannot satisfy acceptance.

## Test plan

Use two disposable projects with different existing verification commands. Remove a required tool
and leave an advisory tool green. Advance main and verify invalidation. Count invocations to prove
observation does not rerun CI or duplicate local gates.

## Why this approach?

One effective gate contract explains both what ran and what it did not prove.

## Files You'll Touch

| Path                                          | Role             | Contains                         | Edit or Read |
| --------------------------------------------- | ---------------- | -------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts` | Acceptance       | Required check execution         | Edit         |
| `factory/persistence.ts`                      | Evidence         | Revision, version, coverage      | Edit         |
| `factory/setup-factory.ts`                    | Discovery        | Check-only capability validation | Edit         |
| `factory/checks.sh`                           | Existing command | Gate stages                      | Read         |
| `factory/README.md`                           | Contract         | Tool roles and missing checks    | Edit         |

Use the accepted definition schema paths; do not create another authoritative format.

## Initial state / preflight

Execute common preflight in `docs/v1-execution.md`. Tool capability checks remain pending.

| Command                                     | Expected result / action              |
| ------------------------------------------- | ------------------------------------- |
| `git rev-parse HEAD`                        | Confirm accepted definition revision. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect check and evidence changes.   |

## Done when

- [ ] Existing tool roles are reused and mandatory absences block acceptance.
- [ ] Results identify exact revisions, versions, and coverage without duplicate execution.
- [ ] Full gates and cold review pass.
