# v1-ticket4

## Status

- Goal: retain private, revision-bound evidence outside disposable worker storage.
- Initial priority: P0. Effort: Medium. Risk: elevated; disclosure and stale proof affect
  acceptance.
- Depends on: v1-ticket2.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F02 and F07. Local only; pending definition acceptance.

## Why this matters

A worker-local log link cannot support later recovery or retirement once that orb is gone.

## Current state

SQLite owns tickets, runs, and events. Candidate reports, check logs, and bookkeeping evidence
remain separate. The dashboard exposes curated revision references but no inspectable evidence.

## Approach

Persist evidence identity, check/tool version, revision, outcome, and private content references
under coordinator ownership. Import required artifacts before acceptance records claim preservation.
Expose an allowlisted read projection, not arbitrary paths or raw files.

## Scope

Include evidence migration/import/read contracts. Exclude lessons, backup publication, frontend
rendering, remote CI adapters, and storing full transcripts or credentials.

The richer public lifecycle feed belongs to v1-ticket23. This unit establishes the private evidence
identities and preservation contract it consumes. Full scheduled runs belong to F15.

## Steps

1. **Record revision bound evidence**. Extend existing SQLite transactions with idempotent identity.
2. **Preserve required private artifacts**. Verify content exists beyond the worker's filesystem.
3. **Expose curated evidence reads**. Reject traversal, unknown identities, and private-field
   canaries.

## Test plan

Use real SQLite and HTTP with temporary worker directories. Remove a copied fixture source only
after preservation, then read evidence from the coordinator. Reject missing, corrupt, duplicate, and
stale-revision artifacts. Read failures must not create or mutate storage. Private reports and raw
blocked text can contain secrets; public references remain allowlisted.

## Why this approach?

Evidence references need a validated owner and artifact identity, not a browser-supplied filename.

## Files You'll Touch

| Path                                                    | Role       | Contains                       | Edit or Read |
| ------------------------------------------------------- | ---------- | ------------------------------ | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Storage    | Evidence records and migration | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Acceptance | Preservation boundary          | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | HTTP       | Curated evidence reads         | Edit         |
| `factory/README.md`                                     | Contract   | Evidence coverage and refusals | Edit         |

Build storage/import before the acceptance and HTTP consumers.

## Initial state / preflight

Execute the common preflight in `docs/v1-execution.md`. Checks were not run during authoring.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record definition digest and actual evidence storage. |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate persistence and acceptance changes.        |

## Done when

- [ ] Required evidence remains readable privately without worker storage.
- [ ] Public reads exclude private contents and stale proof cannot authorize acceptance.
- [ ] Migration, full gates, guard, and cold review pass.
