# Feature 04: persist coordinator state in SQLite

## Status

- State: verified and accepted in the disposable factory. Priority: P0. Category: feature.
- Story: [feature-04-story.md](feature-04-story.md). Backlog item: F02 core persistence.
- Worker: one Sol 6.1 child at medium effort. No nested delegation or review panels.

## Why this matters

`factory/native.ts` writes state JSON and transition events separately. A restart can see one write
without the other. SQLite gives the coordinator an atomic transition record and a schema version
before private snapshots and restore are added.

## Current state

`createFactory` reads `.git/factory/state.json`, appends `events.jsonl`, and serializes local ticks.
The supplied poteto store owns a cross-process lock and revision ledger. Preserve that unchanged
integration. The configured ticket manifest is operator input, and candidate reports remain worker
output files. `factory/plugin.ts` and the dashboard consume the public tick result rather than
reading the state JSON directly. Tests also create legacy state fixtures intentionally.

Feature 03 now handles disconnected observations with supported Amp status fallback and verifies
candidates asynchronously. Keep both behaviors. Native server status may be unavailable outside
an invocation context; unknown must preserve ownership.

## Approach

Add the smallest coherent SQLite storage module, with records for coordinator, tickets, runs, and
events. The existing discriminated run model can remain the in-memory contract. Keep database
ownership in one place instead of scattering SQL through the lifecycle loop. Use synchronous,
short SQLite transactions for local persistence, not for remote actions or verification waits.
Only the first schema version is needed; explicitly reject newer versions.

Persist each state change and its corresponding event in one transaction. Inspect every current
`atomic` and `event` call so ordering cannot leave mismatched ownership and history. Standalone
diagnostic events need no artificial state transition. Preserve accepted revision evidence.

Migrate legacy records once on a mutating lifecycle operation, preserving original files. Status
may read existing state but must not initialize or migrate anything. Validate legacy records before
recording successful initialization. Reopening a migrated database must not reread stale legacy
state as authoritative. Retain records for claimed work even if the operator edits the manifest.

## Scope

- In: `factory/native.ts`, `factory/native.test.ts`, `factory/plugin.test.ts`, `factory/README.md`,
  and `factory/persistence.ts` with `factory/persistence.test.ts` if a module is needed.
- Out: plugin API changes, frontend changes, PostgreSQL, ORM dependencies, backup destinations,
  external provisioning, poteto store changes, worker retirement, and broad lifecycle redesign.

## Test plan

- Start a real disposable project, dispatch one simulated worker, reopen the coordinator, then
  accept its original revision. Check real SQLite records and preserved public control results.
- Migrate nonempty legacy state and events, reopen twice, and prove no duplicate imports or
  replacement calls. Include running, ambiguous delivery, creating, and accepted records.
- Force a transaction failure and prove state and its event both roll back. Expected values must
  not be derived from the implementation under test.
- Malformed legacy JSON, malformed JSONL, invalid state shapes, corrupt SQLite, and unsupported
  versions fail closed without dispatch or replacement of original bytes.
- Prove status on fresh and legacy repos performs no migration writes. Verify execution remains
  off unless already authorized. Keep the asynchronous responsiveness regression passing.
- Update tests that inspect legacy files only where storage ownership changes; preserve assertions
  about externally visible behavior. Run full `bun test`, strict SDK TypeScript, and whitespace.

## Done when

All story criteria have direct behavioral checks. Parent reviews the patch, runs the existing suite,
and exercises migration and reopen against a preserved live fixture without new model calls.

## Throughput checkpoint

- Blocking first step: commit a snapshot of the exact parent source and this ticket in the fixture.
- Independent workstreams: none. One implementation worker owns one worktree.
- Shared mutable state: SQLite transactions are short; existing cross-process ownership remains.
- Smallest safe unit: state, transition history, and legacy migration must change together.

## Notes

Read poteto-mode and do the work directly. Keep full logs local and report concise results. Do not
change acceptance criteria, config permissions, or the parent checkout. Parent owns final commits.
No push, external ticket write, deployment, backup provisioning, or worker cleanup is authorized.

## Drift log

2026-11-13. One Sol 6.1/medium worker returned its original attempt-1 candidate. The factory
verified and integrated it in the fixture. Parent review copied its six-file patch into this
checkout and reran 74 tests with 1,159 assertions, strict SDK TypeScript, and whitespace checks.

The parent refreshed the actual plugins for the preserved Feature 02 and Feature 03 fixtures.
Both migrated their nonempty legacy records, then reopened and reconciled without new workers,
model calls, or acceptance duplication. Original state and event file bytes remained unchanged;
the stored acceptance revisions still matched their Git roots. Both queues stayed paused.
The repeatable check and its input receipt are under `.amp/in/scratchpad/factory-feature-04/`.

Coordinator status performs no storage writes. The pre-existing plugin dashboard projection still
refreshes on control calls, including status; this ticket did not change that separate behavior.
Evidence and lessons remain in their existing locations rather than speculative new tables.
