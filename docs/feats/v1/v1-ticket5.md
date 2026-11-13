# v1-ticket5

## Status

- Goal: persist concise phase lessons and retrieve only relevant verified findings.
- Initial priority: P1. Effort: Medium. Risk: elevated; stale lessons can misdirect future workers.
- Depends on: v1-ticket4.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F04. Local only; pending evidence acceptance.

## Why this matters

Dependency insights alone do not retain failed approaches, corrections, and unresolved questions.

## Current state

`Run.done.insight` and handoff dependency text exist. Structured lessons and supersession do not.

## Approach

Store project, ticket/phase, source thread, revision, scope, verification references, and concise
findings in SQLite. Key writes by phase and source revision. Record supersession without erasure.
Retrieve bounded relevant lessons when the existing handoff is formed.

## Scope

Include lesson validation, persistence, supersession, and delivery to affected workers. Exclude
transcript ingestion, embeddings, a new search service, and automatic ticket acceptance.

## Steps

1. **Persist sourced phase lessons**. Separate verified findings, failed approaches, and questions.
2. **Retrieve only relevant lessons**. Match project and affected scope within a bounded handoff.
3. **Prove supersession and delivery**. Retain old sources without teaching contradicted findings.

## Test plan

Use asymmetric A/B/C scopes. A's lesson reaches dependent B and an affected active worker, not
unrelated C. Repeat completion and restart with one summary. Supersede a lesson and retain its
source. Reject credentials and full transcripts. A summary alone never releases dependents.

## Why this approach?

Source-bound records let later workers distinguish established facts from unresolved hypotheses.

## Files You'll Touch

| Path                                                    | Role     | Contains                          | Edit or Read |
| ------------------------------------------------------- | -------- | --------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Memory   | Lessons and supersession          | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Handoff  | Relevant retrieval                | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Delivery | Supported active-worker messaging | Edit         |
| `factory/README.md`                                     | Contract | Lesson boundaries                 | Edit         |

Build lesson storage before retrieval and native delivery.

## Initial state / preflight

Execute `docs/v1-execution.md` preflight after evidence adoption. Authoring ran no lesson checks.

| Command                                     | Expected result / action                       |
| ------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD`                        | Identify accepted evidence APIs before coding. |
| `git diff --stat 62816cf..HEAD -- factory/` | Review handoff and persistence drift.          |

## Done when

- [ ] Relevant workers receive sourced findings once; unrelated workers and secrets are excluded.
- [ ] Supersession is traceable and lessons do not count as acceptance proof.
- [ ] Full gates and required independent review pass.
