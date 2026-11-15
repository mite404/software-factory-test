# F004-keyed-creation-delivery

## Status

- Goal: recover an unclear thread creation or message delivery by looking for it, not by parking
  it for the Foreman.
- Initial priority: P1. Effort: Medium.
- Risk: elevated; a wrong lookup would create a duplicate worker or send a brief twice.
- Depends on: F002-worker-runner-executor and PR #24 (merged). Complements v1-ticket10.
- Planned at: `af884ca62b0586646e30743a2fc2258ac68346e6`, 2026-11-14. Local only.

## Why this matters

On 2026-11-14 Amp refused one worker creation and the run parked in `creating`. Nothing was
created, yet the queue stopped until the Foreman added and called `retry-create` by hand. The same
parking applies to a message whose send result is lost. The operator wants runs to survive
errors and disconnects without a manual step.

## Current state

- `factory/native.ts` `createWorker` persists `creating`, then calls `host.create`. A thrown call
  leaves the run in `creating` with a `creation-unknown` incident, recovery `inspect`.
- Review creation does the same through `review.delivery: "creating"`.
- `send` persists `sending`, then calls `host.send`. A thrown call becomes `uncertain` with a
  `delivery-unknown` incident.
- Every tick returns early while a run is `creating` or `uncertain`.
- `retry-create` (PR #24) repeats a worker creation only after the Foreman records that no thread
  exists. There is no equivalent for a parked review creation or an uncertain delivery.
- `host.create` and `host.send` carry no identifier that a later lookup could match.
- `amp.find_thread` accepts a `parent:` filter that lists the direct children of a thread. Whether
  a plugin-created thread can carry a label or title at creation has not been inspected.

## Approach

Give each creation and each delivery a deterministic key built from the ticket, attempt, role and
purpose, and store it before the remote call. After an unclear result, look for the key through a
supported read. If the lookup is conclusive, continue: adopt the thread that exists, or repeat the
call when none exists. If the lookup is unavailable or ambiguous, park exactly as today.

Discover the supported lookup before designing: how a created thread can be matched to its key,
and how a delivered message can be recognized in the target thread.

## Scope

- In: keys, the lookup, automatic continuation of `creating`, review `creating` and `uncertain`
  runs when the lookup is conclusive, tests, README and foreman.md.
- Out: replacing a worker or reviewer, guessing from assistant prose, and unbounded retries.
- Out: provider limits (F003) and ownership transfer (F005).
- Preserve: `retry-create` and the parked path for every inconclusive case.

## Steps

1. **Store a stable key**. Derive the key for each creation and delivery, persist it with the
   intent before the remote call, and keep saved state from before this change opening unchanged.
2. **Look before retrying**. After an unclear creation or delivery, read the supported source of
   truth for that key and classify the result as present, absent or inconclusive.
3. **Continue conclusive outcomes**. Adopt a present thread or delivery, repeat an absent one
   exactly once, and record which evidence decided it.
4. **Park inconclusive outcomes**. Leave the existing incident and Foreman recovery untouched when
   the lookup fails or matches more than one candidate.
5. **Document automatic recovery**. Describe what recovers by itself and what still parks.

## Test plan

Use the existing fixture hosts. Cover: a creation that throws after the thread exists is adopted
and no second thread is created; a creation that throws before the thread exists is repeated once;
an ambiguous lookup parks with the current incident; the same three cases for review creation and
for delivery; a second reconcile after recovery creates and sends nothing more. Count creations
and sends in the fixture and compare them with expected totals written in the test.

## Why this approach?

- Without it: any lost response stops the queue until a person inspects it, even when the answer
  is one read away.
- This buys: recovery that never guesses. A repeat happens only after a read shows the first
  attempt left nothing behind, so the no-duplicate rule holds without a human.

## Files You'll Touch

| Path                                          | Role      | Contains                               | Edit or Read |
| --------------------------------------------- | --------- | -------------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle | `createWorker`, `send`, review create  | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts` | Adapter   | `host.create`, `host.send`, lookups    | Edit         |
| `factory/persistence.ts`                      | Records   | Keys on run and review records         | Edit         |
| `factory/review.test.ts`                      | Tests     | Existing creation and delivery unknown | Edit         |
| `factory/README.md`, `factory/foreman.md`     | Operation | Parked work and recovery               | Edit         |
| `node_modules/@ampcode/plugin/index.d.ts`     | API       | Thread creation and read options       | Read         |

Build order: keys, lookup, continuation, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.      |
| `git diff --stat af884ca..HEAD -- factory/`             | Revalidate drift in the files above.           |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                    |
| `rg -n "creation-unknown\|delivery-unknown" factory/`   | The current parked paths.                      |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity |

## Done when

- [x] An unclear delivery with a conclusive lookup continues without the Foreman. Creation stays
      parked because no supported lookup exists (see Notes).
- [x] No case creates a second thread or delivers a brief twice.
- [x] An inconclusive lookup parks exactly as before.
- [x] Saved state from before this change opens unchanged.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

The Foreman probes the live lookup shapes before dispatch and puts them in the brief. If no
supported lookup exists for one of the two cases, that case stays parked and the ticket says so.

Outcome: delivery recovers by reading the thread's full paginated messages. Creation stays parked:
the plugin API has only `threads.get(id)`, with no list or search, so no lookup is conclusive. The
native check rejected the candidate only on an unformatted base `.factory-tickets.json` outside
the ticket's paths, so the Foreman ran the cold review with ce-code-review on the exact commit.
Its non-blocking follow-ups: treat an absent read right after a failed send as inconclusive until
a short settle delay passes, delete only a `delivery-unknown` incident on recovery, and await the
`rejects.toThrow` assertions in `native.test.ts` and `review.test.ts`.
