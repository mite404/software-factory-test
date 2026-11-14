# foreman-watchdog-ticket2

## Status

- Goal: detect unresolved incidents and excessive repair spending without stopping safe work.
- Initial priority: P0. Effort: Medium.
- Risk: elevated; incidental events must not hide a stall or cause duplicate workers.
- Depends on: foreman-watchdog-ticket1.
- Planned at: `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14. Local only.

## Why this matters

A delivered notice does not prove the Foreman acted. Conversely, a long build is not proof of a
hang, and repeated rejected attempts can consume credits while continually recording progress.

## Current state

SQLite events have ordered IDs and ISO timestamps; `lastEvent` returns only detail. There is no
injected clock, durable nudge policy, blocked-age alert or repair-spending alert. Diagnostic events
are stored alongside lifecycle events, so the latest arbitrary event is not a progress clock.

## Approach

Use ticket/attempt/incident-bound progress and notification times. Reconcile elapsed-time policy
with a minimal injectable clock. Defaults are a 30-minute suspicion threshold and at most one
Foreman nudge per threshold interval. Alert the user at the first unresolved threshold, not after
two additional silent nudge periods. A suspicion triggers diagnosis, never a duplicate worker.

Record a separate non-blocking spending alert at attempt six and every four attempts thereafter.
Keep this policy in the accepted project definition, not another configuration file. Persist alert
intent and acknowledgment for ticket3's connected delivery; this unit does not claim live push.
Notices, errors, observation refreshes and unrelated tickets do not reset meaningful progress.

## Scope

- In: incident timing, nudge and alert intent, spending thresholds, deterministic policy tests.
- Out: schedules, push delivery, frontend, provider usage billing and automatic permission changes.
- Planned/dependency-waiting work alone is not stalled. Explicitly paused or complete factories
  produce no new nudges or alerts. Observation and status stay read-only.

## Steps

1. **Track meaningful incident progress**. Separate lifecycle progress from diagnostics and notices.
2. **Bound nudges and alerts**. Persist incident-scoped timing and a separate spending policy.
3. **Verify timing and recovery**. Test exact boundaries, reload, ambiguity and quiet states.

## Test plan

Drive the public native interface with real SQLite and an injected clock on both sides of the
threshold. Prove one nudge per interval, one normal alert per episode, crash recovery, and no reset
from the nudge's own event. Unrelated progress must not hide a stuck ticket. A still-running or
unknown worker must not be duplicated or treated as idle. Verify attempts six and ten alert without
parking, while attempts five, seven and nine do not. Paused/completed and planned-only cases remain
quiet. Persisted policy decisions must survive plugin reload and repeated reconciliation.

## Why this approach?

A global last-event timestamp can reset itself forever. Incident-scoped facts catch a silent handoff
without confusing it with an unrelated build or inferring acceptance from elapsed time.

## Files You'll Touch

| Path                                                    | Role       | Contains                                   | Edit or Read   |
| ------------------------------------------------------- | ---------- | ------------------------------------------ | -------------- |
| `factory/persistence.ts`, `factory/persistence.test.ts` | State      | Incident timing and alert intent           | Edit           |
| `factory/native.ts`, `factory/native.test.ts`           | Policy     | Clock, progress and bounded reconciliation | Edit           |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Adapter    | Serialized policy integration              | Edit if needed |
| `factory/README.md`                                     | Contract   | Thresholds, latency and unknown semantics  | Edit           |
| Accepted v1-ticket2 definition/schema paths             | Definition | Validated watchdog policy                  | Edit           |

Revalidate accepted definition paths before editing; they do not yet exist at planning time. Build
policy and behavioral proof before adapter changes; do not mutate inside heartbeat publishing.

## Initial state / preflight

Run shared preflight in `docs/v1-execution.md`; authoring has not run implementation checks.

| Command                                                 | Expected result / action                            |
| ------------------------------------------------------- | --------------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Confirm notice and exact-incident guards accepted.  |
| `git diff --stat 2c00930..HEAD -- factory/`             | Inspect clock and event changes from prerequisites. |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                         |

## Done when

- [ ] Unresolved incidents cause bounded nudges and first-threshold user-alert intent.
- [ ] Diagnostic events cannot conceal a stall; active/unknown work cannot be duplicated.
- [ ] Excessive repair attempts request non-blocking alerts independently of progress timing.
- [ ] Full gates, guard and fresh cold review pass with restart and threshold-boundary evidence.
