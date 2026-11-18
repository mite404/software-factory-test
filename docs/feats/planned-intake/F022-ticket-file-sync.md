# F022-ticket-file-sync

## Status

- Goal: a ticket file saved under `docs/feats/` becomes a planned row in the factory database on
  the next reconcile, with no hand copy, and can never be dispatched by that alone.
- Outcome: Saved tickets appear as planned on their own
- Initial priority: P1. Effort: Medium.
- Risk: elevated; it adds a second source for the queue. A mistake could admit work nobody
  approved, so synced rows are always `planned` and admission stays a separate owner action.
- Depends on: planned-intake-ticket1 (done). F010-brief-fact-check later checks the brief at
  admission; this ticket does not.
- Planned at: `fa429646343efd36414251c5f56612f1722f7b9d`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the operator asked why 16 planned tickets were on the dashboard when the repository
held 44 unfinished ticket files, and said tickets should reach the database once they are saved
to the repository. Today they do not: the Foreman copies each ticket's step labels and outcome
into `.factory-tickets.json` by script and calls `reload`. The copy goes stale, and a ticket
nobody copied is invisible to the factory and the dashboard.

## Current state

- `tasks` in `factory/native.ts` parses the queue file named by the definition's `tickets`
  setting. It is read only by `reload` and `admit` in the `tick` function of that file.
- `refreshTickets` in `factory/persistence.ts` writes those rows to the SQLite `tickets` table and
  skips a row already stored as `admitted`, so an admitted ticket is frozen.
- `ticketIntake` in `factory/persistence.ts` refuses an authored `admitted` row and requires an
  `outcome` on a planned row.
- Nothing in `factory/` reads `docs/feats/`. Ticket files have no outcome line; the Foreman
  writes the outcome by hand in the queue file.
- The create ticket skill in `.agents/skills/creating-factory-tickets/` writes Markdown only.

## Approach

Add an optional definition setting, `ticketFiles`, a directory relative to the root. When set,
`reload` and every owner `reconcile` read the ticket files below it and merge them into the queue
before `refreshTickets` runs. A ticket file is a Markdown file whose name matches
`F<NNN>-<slug>.md`, whose H1 equals its name, and which is not under a `done` directory.

For each ticket file with no entry of the same id in the queue file, build a planned row: `id`
from the name, `steps` from the bold labels of the numbered list under `## Steps`, `outcome` from
the `- Outcome:` line under `## Status`, and the brief `Implement <path>`. An entry in the queue
file wins over the ticket file field by field, so the Foreman's real brief, `after`, `size` and
`risky` still come from there. A synced row that has no run and whose ticket file is gone or has
moved to `done` is removed. A row stored as `admitted`, or with a run, is never changed.

A ticket file that cannot be read as a ticket (no outcome line, no step labels, H1 mismatch) is
skipped and named in `status` under a new `skippedTickets` list with its reason. It does not stop
the reconcile.

## Scope

- In: the setting and its schema, the reader, the merge, the status list, tests, README, the
  ticket skill's example and text (add the Outcome line), and an Outcome line on every open
  `F<NNN>-` ticket file.
- Out: tickets named `<feature>-ticket<N>`. They keep working through the queue file.
- Out: admission, dispatch, the worker brief check (F010) and the dashboard page.
- Out: watching the file system. The owner reconcile already runs on every watchdog wake and
  every Foreman turn that touches the factory.

## Steps

1. **Read ticket files**. Add a pure reader that turns one ticket file's text and path into a
   planned row or a skip reason, and a walker that applies it below `ticketFiles`.
2. **Merge into the queue**. Merge synced rows with the queue file in `reload` and owner
   `reconcile`, queue file first, and remove synced rows whose file is gone and that have no run.
3. **Keep admission separate**. Prove that no ticket file content can produce an admitted row,
   change an admitted row, or start a worker.
4. **Report skipped files**. Publish `skippedTickets` in `status` with a reason per file, and
   keep private text out of it.
5. **Add outcome lines**. Add the Outcome line to the skill, its example and every open
   `F<NNN>-` ticket file, and set `ticketFiles` in this repository's definition.
6. **Document the sync**. Describe the setting, the precedence rule and the skip list in the
   README and the Foreman prompt.

## Test plan

- Reader: a valid ticket, a missing outcome, no bold labels, an H1 that differs from the name, a
  file under `done`, and a name that is not `F<NNN>-`. Use asymmetric fixtures: three steps where
  the second label contains a colon and an arrow.
- Merge: a ticket file alone gives a planned row; a queue entry with the same id keeps its brief
  and `after`; deleting the file removes the row; deleting the file of a ticket with a run does
  not.
- Admission: a ticket file whose Status says `intake: admitted` still yields `planned`; an
  admitted row is byte-identical in SQLite before and after a sync with a changed ticket file;
  a sync on a started factory creates no thread.
- Privacy: plant a canary in a ticket's Approach; prove it reaches neither `status` nor the feed.
- A reconcile with one unreadable ticket still syncs the others.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: the queue file is a hand copy of the tickets. It was 28 tickets short on
  2026-11-15 and the Foreman admitted F021 from a base that lacked its ticket file.
- This buys: the ticket file owns what the work is, the queue file owns what only the Foreman
  knows (the brief and the order), and the database owns state. Because a synced row can only be
  `planned`, saving a file cannot dispatch anything; `admit` stays the single gate.

## Files You'll Touch

| Path                                         | Role              | Contains                         | Edit or Read |
| -------------------------------------------- | ----------------- | -------------------------------- | ------------ |
| `factory/persistence.ts`                     | Storage boundary  | `ticketIntake`, `refreshTickets` | Edit         |
| `factory/native.ts`                          | Lifecycle         | `tasks`, `reload`, `reconcile`   | Edit         |
| `factory/definition.schema.json`             | Definition schema | The `ticketFiles` setting        | Edit         |
| `factory/persistence.test.ts`                | Storage proof     | Merge and frozen-row cases       | Edit         |
| `factory/native.test.ts`                     | Lifecycle proof   | Sync on reload and reconcile     | Edit         |
| `factory/README.md`, `factory/config/agents/foreman/agent.md`    | Operator contract | Setting, precedence, skip list   | Edit         |
| `.agents/skills/creating-factory-tickets/`   | Ticket format     | Outcome line in text and example | Edit         |
| `docs/feats/**/F*.md`                        | Tickets           | One Outcome line each            | Edit         |
| `factory/definition.yaml` or `.factory.json` | This repo's setup | `ticketFiles: docs/feats`        | Coordinator  |
| `factory/dashboard.ts`                       | Feed              | Reads planned rows; unchanged    | Read         |

Build order: reader and its tests, merge and its tests, status list, then the documents and the
ticket files. The definition file is the coordinator's to edit, not the worker's.

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                     | Expected result / action                                |
| ------------------------------------------- | ------------------------------------------------------- |
| `git rev-parse HEAD`                        | Record it; explain differences from the planning SHA.   |
| `git status --short`                        | Clean, or every edit accounted for.                     |
| `git diff --stat fa42964..HEAD -- factory/` | Revalidate `tasks`, `refreshTickets`, `ticketIntake`.   |
| `git diff -- factory/`                      | No unaccounted unstaged changes.                        |
| `git diff --cached -- factory/`             | No unaccounted staged changes.                          |
| `rg -n "ticketFiles" factory`               | No matches before the work.                             |
| `bun test factory`                          | Baseline passes; record the outcome. One run at a time. |
| `bun run lint:ci && bun run typecheck`      | No errors.                                              |
| `bun run format:check && bun run fallow:ci` | Pass.                                                   |
| `bash factory/checks.sh guard`              | Pass.                                                   |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] A new `F<NNN>-` ticket file appears as a planned row after one reconcile, with its step
      labels and outcome, and no edit to the queue file.
- [ ] No ticket file content can admit a ticket, change an admitted row or start a worker.
- [ ] A queue entry's brief, `after`, `size` and `risky` win over the ticket file.
- [ ] An unreadable ticket file is listed in `status` with its reason and stops nothing.
- [ ] Every open `F<NNN>-` ticket file has an Outcome line and shows on the live dashboard.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
