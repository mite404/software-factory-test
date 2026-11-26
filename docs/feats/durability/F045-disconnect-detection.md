# F045-disconnect-detection

## Status

- Goal: the factory notices a worker or reviewer that may have stalled.
- Outcome: The factory reports a suspected stall within minutes, before the suspicion nudge.
- Initial priority: P1
- Effort: Medium
- Risk: risky; recovery and concurrency. A false positive must never replace, duplicate or resume a
  healthy worker.
- Depends on: none.
- Planned at: `6eda5a9845dd02a62e50afff7c0c4a71de7ddc7f`, 2026-11-26.
- Local path: `docs/feats/durability/F045-disconnect-detection.md`

## Why this matters

The Foreman prompt (`factory/config/agents/foreman/agent.md:101-103`) defines a disconnected
thread as one whose tools fail with an executor error, or that stays in `running_tools` for three
minutes after a delivery with no worktree change. No code implements that rule. Until the Foreman
happens to look, the run reads as running, and the only automatic signal is the 30-minute
suspicion nudge. F042's restricted Foreman has no CLI reconnection at all, so under that role a
disconnected worker is invisible and unrecoverable without an outside operator.

## Current state

At `6eda5a9`:

- `factory/plugin.ts` `activity()` maps only `idle`, `running`, `awaiting-approval` and `error`;
  anything else becomes `unknown`. The local SDK state is `ThreadState`
  (`node_modules/@ampcode/plugin/index.d.ts:1425`), which has no `running_tools`.
- `observe()` (`plugin.ts` ~line 446) calls connected `amp.get_thread_status` only when the local
  state is `error`. So `running_tools` and its `updatedAt` are never read today.
- `settle` (`native.ts` ~line 3955) keeps a `running` or `unknown` worker with no clock.
- The suspicion nudge (`native.ts:164`, `suspicionMs` 30 minutes in `persistence.ts:66`) is the
  only stall timer.
- Live `amp.get_thread_status` replies observed 2026-11-26 are in the
  [redacted fixture](../../../factory/fixtures/thread-status-live.json):
  `{"state":"running_tools","updatedAt":"2026-11-26T16:46:52.149Z"}`,
  `{"state":"streaming","updatedAt":"2026-11-26T16:47:27.687Z"}`,
  `{"state":"idle","updatedAt":"2026-11-26T16:38:03.267Z"}`.
- The executor-error half of the rule has no observed reply shape yet.

## Approach

On each connected reconcile, for each running worker or reviewer, read connected
`get_thread_status` and record, where it happens, the platform state, its `updatedAt`, and a
worktree fingerprint (HEAD, porcelain status, and changed file contents). Open a `disconnected` stop
only when a later reconcile sees the same `running_tools` state with the same `updatedAt`, the same
fingerprint, and the stall window has reached `disconnectMs` (180 000 ms by default). Start the
window at `updatedAt` on the first sample with a readable tree and at the observation time after
progress. Connected progress still resets the window when the worktree cannot be read. It survives
restart, and no missing fingerprint counts as unchanged. The watchdog is retimed in place by
schedule ID to one minute during work that can need stall checks. The 30-minute suspicion nudge
is unchanged.
Tracked binary diffs stream into the fingerprint rather than depending on a fixed output buffer.

The stop keeps the same worker, thread, worktree, and attempt. `reconnect` names an operator
decision, not a factory action. A later connected sample with a new `updatedAt`, a changed
fingerprint, or a state change clears the stop. Without connected evidence, nothing is inferred.

## Scope

- In: the connected status read for running threads, the recorded observation, the stop, its
  automatic clearing, lifecycle table entry, feed stage, tests, README and Foreman prompt rule.
- Out: performing the reconnection (CLI continuation or any new launcher); the restricted role
  cannot run it, and the mechanism needs its own permission decision.
- Out: the executor-error half until preflight records a real reply that shows it.
- Out: changing the suspicion nudge or provider-limit handling.

## Steps

1. **Read platform thread state**. For running workers and reviewers, call connected
   `get_thread_status` and keep `running_tools`, `streaming` and `updatedAt` instead of mapping
   them to `unknown`; keep the local-state path when tools are disconnected.
2. **Record observations where seen**. Persist state, `updatedAt` and worktree fingerprint on the
   run at observation time; never derive staleness from a missing record or a read-time clock
   alone.
3. **Open the disconnected stop**. Add a `disconnected` stop to `runLifecycle.running` with its
   actor, reason and `reconnect` recovery, and open it only on the unchanged-for-threshold rule.
4. **Clear on observed progress**. Close the incident on a changed `updatedAt`, changed
   fingerprint, or idle activity, and write no event when nothing changed.
5. **Replace the prompt rule**. Point the Foreman prompt at the stop instead of the three-minute
   prose rule, and document it in the README.

Illustrative queue entry, not authorization to change the coordinator queue or dispatch work.

```json
{
  "id": "F045-disconnect-detection",
  "brief": "Implement docs/feats/durability/F045-disconnect-detection.md",
  "after": [],
  "size": "medium",
  "risky": true,
  "steps": [
    "Read platform thread state",
    "Record observations where seen",
    "Open the disconnected stop",
    "Clear on observed progress",
    "Replace the prompt rule"
  ]
}
```

## Test plan

Fixtures copy the recorded live reply shapes above.

- `running_tools`, same `updatedAt`, same fingerprint, 181 s old: stop opens. At 179 s: no stop.
- Same as the first case but a new commit or an untracked file in the worktree: no stop.
- Same as the first case but `updatedAt` moved, or state `streaming`: no stop.
- An open stop clears on a later changed `updatedAt` or idle observation; the worker, thread,
  attempt and worktree are unchanged and nothing is sent to the thread.
- Disconnected owner tools: no status call, no stop, run unchanged.
- Two reconciles with nothing new write no second event or incident.
- A restart between observations keeps the recorded observation and still opens the stop on time.
- Full configured gate and the required cold post-graft review on the exact candidate.

## Why this approach?

- Without this structure: detection depends on the Foreman watching a clock, the 30-minute nudge
  is the only backstop, and the restricted Foreman cannot act at all.
- This buys: the platform's own `updatedAt` plus a recorded worktree fingerprint make the decision
  from facts observed at the time, and a stop that only reports and self-clears cannot harm a
  healthy worker. Reconnection stays a separate, permissioned action.

## Files You'll Touch

| Path                                    | Role              | Contains                           | Edit or Read |
| --------------------------------------- | ----------------- | ---------------------------------- | ------------ |
| `factory/plugin.ts`                     | Native adapter    | Connected status read and mapping  | Edit         |
| `factory/native.ts`                     | Coordinator       | Observation, stop, clearing        | Edit         |
| `factory/persistence.ts`                | Durable types     | Lifecycle table, policy, run field | Edit         |
| `factory/plugin.test.ts`                | Adapter proof     | Live reply shapes                  | Edit         |
| `factory/native.test.ts`                | Lifecycle proof   | Threshold and clearing cases       | Edit         |
| `factory/watchdog.ts`                   | Watchdog          | Suspicion nudge exemplar           | Read         |
| `web/derive.ts`                         | Reason sentences  | Sentence for the new reason        | Edit         |
| `factory/config/agents/foreman/agent.md` | Foreman prompt   | Disconnect rule in step 5          | Edit         |
| `factory/README.md`                     | Operator contract | Stop, threshold, limits            | Edit         |

Build order: adapter and its tests, persistence types, coordinator logic and tests, then the
reason sentence, prompt and README.

## Initial state / preflight

Not run while authoring. The coordinator runs these before dispatch.

| Command                                         | Expected result / action                          |
| ----------------------------------------------- | ------------------------------------------------- |
| `git rev-parse HEAD`                            | Record; explain drift from `6eda5a9`.             |
| `git status --short`                            | Account for existing edits; preserve them.        |
| `git diff --stat 6eda5a9..HEAD -- factory/`     | Revalidate the line references above.             |
| Live `get_thread_status` on a busy worker       | Record a `running_tools` reply for the fixture.   |
| Live reply from a thread with an executor error | Record it if observable; otherwise note it absent. |
| `bun install --frozen-lockfile`                 | Succeeds.                                         |
| `bun run lint:ci && bun run typecheck`          | No errors.                                        |
| `bun run format:check`                          | Passes.                                           |
| `bun test`                                      | Baseline passes; record the count.                |
| `bun run fallow:ci`                             | Passes without suppressions.                      |

## Done when

- [ ] A running worker stuck in `running_tools` with an unchanged worktree opens a `disconnected`
      stop after the threshold, shown in status and the feed.
- [ ] Every negative case in the test plan opens no stop, and an open stop clears on observed
      progress without touching the worker.
- [ ] No status call, stop or event happens without connected tools or when nothing changed.
- [ ] The Foreman prompt's three-minute prose rule is replaced by a pointer to the stop.
- [ ] The exact clean candidate passes the full gate and required cold post-graft review.
- [ ] Live proof: one real disconnected worker opens the stop and one busy worker does not.
