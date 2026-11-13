# Feature 04: persist coordinator state in SQLite

As an operator, I can restart the factory without losing queue ownership or transition history,
so recovery depends on durable records rather than the orchestrator's conversation.

## Acceptance criteria

1. Use Bun's built-in SQLite under the repository Git directory. Persist the configured queue,
   coordinator ownership, worker runs, and events with an explicit schema version. No new service
   or dependency is required. Keep live databases and journals out of application history.
2. A state transition and its associated event commit together or neither commits. Do not hold a
   database transaction across worker calls or asynchronous verification commands.
3. Preserve existing JSON state and JSONL events through a one-time, transactional migration.
   Keep original files intact for recovery. Reopening does not import them twice or prefer stale
   legacy files over newer database state.
4. Invalid legacy state, malformed event history, corrupt databases, and unsupported schema versions
   fail visibly before dispatch. Never interpret those cases as an empty project or overwrite them.
5. Reconstruct the same original thread, attempt, delivery state, candidate, and acceptance after
   reopening. Ambiguous creation or delivery remains parked. Repeated reconciliation cannot create
   a replacement worker or reintegrate accepted work.
6. Read-only status creates no database, migration, or runtime files. Existing disabled execution,
   sequential claims, revision checks, unknown observations, and same-worker correction still work.

## Boundary

This is the F02 coordinator-persistence slice. Existing revision evidence and dependency insights
must remain usable. Private backup, restore in another orb, lesson retrieval, dashboard API changes,
and moving the separate poteto bookkeeping ledger into SQLite remain later tickets.
