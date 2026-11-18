# F023-public-stop-reasons

## Status

- Goal: every notice and card that says a ticket was blocked or rejected also says why, in one
  short public line, without publishing private text.
- Outcome: A blocked or rejected ticket says why
- Initial priority: P1. Effort: Small.
- Risk: elevated; it publishes a new field from private state. Only a fixed list of reason codes
  and counted numbers may cross; free text from a worker, a log or a review must not.
- Depends on: nothing. F014-lifecycle-stages later names the stage; this ticket names the cause.
- Planned at: `5fbb1604d8160444cb5346fceaf31bf0cb54e6f0`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the dashboard showed "F021-MERGE-RECORD BLOCKED - the feed gives no reason",
followed five seconds later by "STARTED - handed to a builder". The real event was a gate
rejection: 3 of 216 tests timed out and the same worker was sent back to repair. The operator
said a notice with no reason almost defeats its purpose.

## Current state

- `news` in `web/derive.ts` prints the literal text "the feed gives no reason" for a block and
  "back to its builder" for a failed review. The feed has no reason field.
- `durableTask` in `factory/dashboard.ts` maps a running ticket whose `delivery` is not `sent`
  to `blocked`. A gate rejection sets `delivery` to `queued` until the repair message is sent
  (`reject` in `factory/native.ts`), so a rejection reads as a short block and then a start.
- `commit` in `factory/native.ts` records each stop as an event with an action and, for some
  stops, a reason code: `target-changed`, `worker-error`, `approval-required`,
  `verification-rejected`. A worker's own blocked report stores its free text as the reason.
- A gate failure keeps its exit status and output tails in the private log and the feedback
  sent to the worker.

## Approach

Publish `stop: { code, attempt, at } | null` on each task in the feed, where `code` comes from
one closed list owned by the factory: `gate-failed`, `review-rejected`, `worker-blocked`,
`worker-error`, `approval-required`, `target-changed`, `setup-failed`, `delivery-unknown`,
`escalated`. Set it where the stop is recorded, from the cause the code already knows, never
from report or log text. A stop that has no code publishes `unknown`, so a gap is visible
instead of silent. Clear it when the ticket is accepted.

A gate rejection that sends the same worker back keeps the ticket `working` in the feed and
carries `stop.code = gate-failed` with the attempt that failed, so the page prints one notice,
"gate failed on attempt 1, back to its builder", instead of a block and a start.

The page maps each code to one fixed sentence in `web/derive.ts` and prints it on the notice and
on the ACTIVE card. The literal "the feed gives no reason" is removed.

## Scope

- In: the feed field, the closed list, the rejection status fix, the page wording, tests,
  README.
- Out: counts of failing tests or any log text. F013-event-log-drawer shows events; a later
  ticket can add counted numbers once a parser for them exists.
- Out: the watchdog's user alerts and the Foreman notices, which already carry reasons.
- Preserve: every existing status value and the privacy canary tests.

## Steps

1. **Reproduce the silent block**. Drive a fixture through a gate rejection and record the feed
   and the two notices it produces today.
2. **Publish a stop code**. Add the closed list and the `stop` field, set at every place a stop
   is recorded and cleared on acceptance.
3. **Keep rejection working**. Report a ticket awaiting its repair message as working with
   `gate-failed` or `review-rejected`, not blocked.
4. **Word each stop**. Map every code to one sentence on the notice and the ACTIVE card, and
   remove the placeholder text.
5. **Prove nothing private crosses**. Plant canaries in a worker's blocked reason, a gate log
   and a review finding, and prove none reaches the feed.
6. **Document the codes**. List the codes and their meaning in the README.

## Test plan

- Feed: one fixture per code reaches the feed with that code and the right attempt; a stop with
  no code publishes `unknown`; acceptance clears it.
- Gate rejection at attempt 1: status stays `working`, one notice is derived, and it names the
  gate and the attempt. A second rejection publishes `escalated` and `blocked`.
- Page: `web/derive.test.ts` gets one case per code; no notice text equals the old placeholder.
- Privacy: three canaries, in a blocked report, a gate log and a review verdict, are absent
  from `/api/status`.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: the page can only say that something stopped. Publishing the stored reason
  string instead would leak worker and reviewer text, which the feed has never carried.
- This buys: the factory owns a closed vocabulary of causes, the page owns the wording, and
  private evidence stays in SQLite and the logs. A new kind of stop shows as `unknown` until
  someone names it.

## Files You'll Touch

| Path                        | Role              | Contains                       | Edit or Read |
| --------------------------- | ----------------- | ------------------------------ | ------------ |
| `factory/persistence.ts`    | State types       | The stop code list and field   | Edit         |
| `factory/native.ts`         | Lifecycle         | `commit`, `reject`, stop sites | Edit         |
| `factory/dashboard.ts`      | Feed              | `durableTask`, `projectTask`   | Edit         |
| `factory/dashboard.test.ts` | Feed proof        | Codes, clearing, canaries      | Edit         |
| `factory/native.test.ts`    | Lifecycle proof   | Code set at each stop          | Edit         |
| `web/derive.ts`             | Page model        | `news`, the code sentences     | Edit         |
| `web/derive.test.ts`        | Page proof        | One case per code              | Edit         |
| `web/spec/tickets.tsx`      | Page              | Reason line on the ACTIVE card | Edit         |
| `factory/README.md`         | Operator contract | The code list                  | Edit         |

Build order: the list and field, the stop sites with tests, the feed with tests, then the page.

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                          | Expected result / action                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| `git rev-parse HEAD`                             | Record it; explain differences from the planning SHA. |
| `git status --short`                             | Clean, or every edit accounted for.                   |
| `git diff --stat 5fbb160..HEAD -- factory/ web/` | Revalidate `reject`, `durableTask` and `news`.        |
| `rg -n "the feed gives no reason" web`           | One match before the work, none after.                |
| `bun test`                                       | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`           | No errors.                                            |
| `bun run format:check && bun run fallow:ci`      | Pass.                                                 |
| `bun run web:build`                              | Builds.                                               |
| `bash factory/checks.sh guard`                   | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [x] Every blocked or rejected ticket in the feed carries a stop code from the closed list.
- [x] A gate rejection produces one notice that names the gate and the attempt.
- [x] No notice or card prints "the feed gives no reason".
- [x] Worker, log and review text never reach the feed.
- [ ] The live dashboard shows a reason on a real rejection or block.
- [x] Full gates, guard and a fresh cold review pass on the accepted revision.
