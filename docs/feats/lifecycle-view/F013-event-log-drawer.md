# F013-event-log-drawer

## Status

- Goal: a drawer that slides up from the bottom of the dashboard and shows the factory's live
  event log, backed by an endpoint an agent can read the same way.
- Initial priority: P1. Effort: Medium.
- Risk: elevated; event details hold private briefs, review findings and file paths, and this
  ticket publishes part of the log over HTTP.
- Depends on: nothing accepted later than planned-intake-ticket1. v1-ticket23 extends the same
  endpoint with curated details and replay guarantees.
- Planned at: `36fed66ba4cd40bbcd7d066fbcd0709532e0059d`, 2026-11-15. Local only.

## Why this matters

The operator asked for tracing that both a person and an agent can read. Today the only way to
see what the factory did, in order, is to query its private SQLite file from a shell. On
2026-11-14 and 2026-11-15 the Foreman diagnosed two stops that way; the dashboard could show
neither sequence.

## Current state

- `factory/persistence.ts` appends every lifecycle step to an `events` table: `id`, `at`,
  `ticket`, `action`, `detail`. `detail` is free text and often a JSON record with a worktree
  path, a brief or a full review verdict.
- `factory/native.ts` writes actions such as `creating`, `sent`, `review-sent`,
  `review-verdict`, `rejected`, `escalated`, `review-stopped`, `review-recovered`,
  `repair-resumed`, `accepted`, `notice-sent` and `watchdog-schedule`.
- `factory/dashboard.ts` serves `/api/status` and `/api/definition` and nothing about events.
  It opens the state read-only.
- `web/main.ts` polls `/api/status` on a timer. The page has no log view.
- The gate log and worker transcripts are separate private files and threads.

## Approach

Add `GET /api/events?after=<id>&limit=<n>` to the dashboard server. It reads the events table
read-only and returns rows newer than the cursor, oldest first, with a bounded limit. Each row
carries `id`, `at`, `ticket`, `action`, and only these values taken from `detail` when they
validate: an attempt number, a 40-character revision, and a thread ID. Everything else in
`detail` is dropped. An unknown action still appears, with no detail.

Add a drawer to the existing page: a bar fixed to the bottom edge that opens upward to show
the log, newest at the bottom, following new rows while the reader is at the end. Each row
shows the time, ticket, action and attempt, and links a thread ID to its thread. A filter
narrows the rows to one ticket. The drawer polls the endpoint with the last seen `id` on the
page's existing timer. It opens and closes from the keyboard and remembers nothing between
loads.

Agents use the same endpoint; the README documents its fields as the supported way to trace the
factory without opening the state file.

## Scope

- In: the endpoint, its allowlist and tests, the drawer, its model and tests, README.
- Out: gate output, worker or reviewer transcript text, verdict text, briefs, file paths, and any
  write or control action from the page.
- Out: missed-poll replay guarantees and curated reasons, which v1-ticket23 owns.
- Preserve: `/api/status`, every existing page element, and read-only access to state.

## Steps

1. **Read events by cursor**. Add a read-only query for events after an id with a bounded
   limit, and prove it never writes or initializes storage.
2. **Publish allowlisted rows**. Serve the endpoint with the fixed field allowlist, validating
   each value taken from `detail`.
3. **Model the drawer rows**. Derive display rows, the ticket filter and thread links from the
   endpoint's response in `web/derive.ts`.
4. **Build the drawer**. Add the bottom bar and sliding panel with keyboard control, following
   new rows only while the reader is at the end.
5. **Check it rendered**. Inspect screenshots and a short recording: closed, open with rows,
   filtered to one ticket, and a narrow width.
6. **Document the trace**. Describe the endpoint's fields and limits and the drawer in the
   README.

## Test plan

Endpoint, against real SQLite: rows come back in id order after the cursor and stop at the
limit; a bad cursor or limit is refused; a detail holding a planted private canary, a path and a
verdict yields a row without them; the state file's bytes are unchanged after reads; a missing
state file gives the same unavailable response `/api/status` gives. Model: filter and link
cases. Rendered: the four states above, with the drawer not covering the page's controls when
closed, and reachable and dismissible from the keyboard.

## Why this approach?

- Without it: tracing needs shell access to a private file, which an operator on a phone and an
  agent in another orb do not have. Returning `detail` as stored would publish briefs and
  review findings.
- This buys: one read-only endpoint is the trace for both readers, and a fixed allowlist at
  that boundary decides what leaves the private store. A cursor on the row id makes polling
  cheap and repeat-safe.

## Files You'll Touch

| Path                                                    | Role       | Contains                         | Edit or Read |
| ------------------------------------------------------- | ---------- | -------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | The events table and its readers | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | HTTP       | Routes and the public projection | Edit         |
| `web/derive.ts`, `web/derive.test.ts`                   | Page model | Feed to display rows             | Edit         |
| `web/main.ts`, `web/index.html`, `web/style.css`        | Page       | Polling and drawing              | Edit         |
| `factory/native.ts`                                     | Exemplar   | Which actions are written        | Read         |
| `factory/README.md`                                     | Operation  | Dashboard API                    | Edit         |

Build order: query, endpoint, model, drawer, rendered check, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                           | Expected result / action                        |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                        | Record the dispatch revision; clean tree.       |
| `git diff --stat 36fed66..HEAD -- factory/ web/`                  | Revalidate drift.                               |
| `git diff -- factory/ web/ && git diff --cached -- factory/ web/` | Preserve unrelated changes.                     |
| `rg -n "CREATE TABLE events" factory/persistence.ts`              | The events table.                               |
| `rg -n '"/api/status"' factory/dashboard.ts`                      | The existing route.                             |
| `bun run web:build`                                               | The page builds.                                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`                            | Passes; CI runners have no global Git identity. |

## Done when

- [ ] `/api/events` returns ordered, bounded, allowlisted rows after a cursor and never writes.
- [ ] No brief, path, verdict or other free text from `detail` reaches the response.
- [ ] The drawer opens from the bottom, follows new events and filters by ticket.
- [ ] Thread IDs in rows open their threads.
- [ ] Rendered screenshots and a recording of the drawer are inspected and attached to the report.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

"Active logs" is read here as the factory's own event log. Streaming a worker's gate output or
transcript into the page is a different privacy decision and is left out.
