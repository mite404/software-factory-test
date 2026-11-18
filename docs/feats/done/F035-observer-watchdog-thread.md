# F035-observer-watchdog-thread

## Status

- Goal: routine watchdog wakes and suspicion nudges run in a small Haiku thread that can only
  observe and reconcile, so the Foreman thread wakes only when something needs judgment.
- Outcome: Routine watchdog checks run in a cheap observer thread
- Initial priority: P2. Effort: Medium.
- Risk: elevated; it adds a second caller role to factory control and moves where schedule wakes
  and nudges land.
- Depends on: F014-lifecycle-stages, so the queue order the operator set is kept.
- Planned at: `36d01b39ad4cf5cad6608af726b54dd22f490956`, 2026-11-17. Local only.

## Why this matters

Every watchdog wake and suspicion nudge lands in the Foreman thread, which re-reads its whole
context to answer "still running, no incident". On 2026-11-16 about fifteen wakes and several
stale nudges did exactly that. A separate thread reads a short fixed prompt and a small status
summary instead, and a cheaper model makes each of those tokens cheaper. The operator chose
Claude Haiku 5.5 at high effort for it, and chose that it never becomes the Foreman.

## Current state

- `factory/watchdog.ts` registers one Amp schedule through `amp.set_schedule` with
  `runMode: "existing"` targeting the owner thread; `registration` treats any other run mode as
  drifted.
- `factory/native.ts` sends `Factory suspicion ...` nudges to the owner thread.
- Factory control admits one owner (`state.owner`); reconcile, recovery and admission all check
  it. Non-owner threads get no control tools (`factory/plugin.ts`).
- `status` returns the full state, about 289 KB, too large to read on every cheap wake.

## Approach

Add an observer caller beside the owner. The owner registers one observer thread; the observer
may call `status-summary` and `reconcile` and nothing else. Every recovery, admission, landing
and merge action keeps its owner check. The watchdog schedule and suspicion nudges target the
observer thread, created with model `anthropic/claude-haiku-5-5` and effort high. The observer's
prompt tells it to reconcile, compare with the last summary, and send the owner one message
only for a new verdict, incident, stopped activity, stale lifecycle progress past the suspicion
interval or an alert intent; otherwise it ends its turn without a message. `status-summary`
returns per-run kind, attempt, incident reason, review stage and last progress time, with no
briefs, report paths or thread content.

## Scope

- In: the observer role and its registration, `status-summary`, retargeting the schedule and
  nudges, the observer prompt, tests, README and foreman.md.
- Out: any recovery right for the observer, a model-free reconcile loop, and changing the
  Foreman thread's model.
- Preserve: the owner can still reconcile and read full status; saved state without an observer
  opens unchanged and keeps waking the owner as today.

## Steps

1. **Add the observer role**. Let the owner register one observer thread and admit it only for
   `status-summary` and `reconcile`, with every other action refused.
2. **Add a compact summary**. Return the per-run summary with no private content, small enough
   to read on every wake.
3. **Retarget wakes and nudges**. Point the watchdog schedule and suspicion nudges at the
   observer when one is registered, and at the owner otherwise.
4. **Escalate only on change**. Give the observer a prompt that messages the owner only when the
   summary shows something that needs judgment.
5. **Document the split**. Describe the observer, its limits and how to remove it in the README
   and foreman.md.

## Test plan

With fixture hosts: an observer `reconcile` and `status-summary` succeed; its `resume`,
`retry-create`, `record-landing`, `record-merge`, `admit` and `start` are refused and change
nothing. With an observer registered, the schedule registers against it and a stalled run's
nudge goes to it, not the owner; without one, both go to the owner as today. The summary
contains no brief text, report path or thread content, and stays under a fixed size for a state
with forty runs. A state file written before this change opens unchanged.

## Why this approach?

- Without it: every routine check costs a full Foreman-context turn, and the cost grows with the
  thread until compaction.
- This buys: the observer can at worst miss or over-report a change; it can never take a wrong
  recovery action, because the owner check stays on every one.

## Files You'll Touch

| Path                                                    | Role       | Contains                                 | Edit or Read |
| ------------------------------------------------------- | ---------- | ---------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | Owner, observer, monitor state           | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Control    | Caller checks, nudges, status summary    | Edit         |
| `factory/watchdog.ts`, `factory/watchdog.test.ts`       | Schedule   | Registration target and prompt           | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Tools      | Which threads get which control actions  | Edit         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Observer role and watchdog wake handling | Edit         |

Build order: role and checks, summary, retargeting, prompt, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                              | Expected result / action                        |
| ---------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`           | Record the dispatch revision; clean tree.       |
| `git diff --stat 36d01b3..HEAD -- factory/`          | Revalidate drift, including F011 and F014.      |
| `rg -n 'runMode === "existing"' factory/watchdog.ts` | The schedule target rule.                       |
| `rg -n "Factory suspicion" factory/native.ts`        | The nudge sent to the owner.                    |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`       | Passes; CI runners have no global Git identity. |

## Done when

- [x] An observer thread can reconcile and read the summary, and every other action is refused.
- [x] Watchdog wakes and suspicion nudges land in the observer when one is registered.
- [x] The observer messages the owner only when the summary shows a change needing judgment.
- [x] Without an observer, wakes and nudges reach the owner exactly as today.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
