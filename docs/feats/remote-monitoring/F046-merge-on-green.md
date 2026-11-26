# F046-merge-on-green

## Status

- Goal: the factory refuses to record a merge that skipped green checks or was not a merge commit.
- Outcome: Merges record only after every check on the exact pull request head passed
- Initial priority: P1
- Effort: Medium
- Risk: risky; shared delivery state. A wrong check reading could block every landing or record a
  red merge as clean.
- Depends on: none. Related: remote-monitoring-ticket1 owns publication and live CI monitoring.
- Planned at: `6eda5a9845dd02a62e50afff7c0c4a71de7ddc7f`, 2026-11-26.
- Local path: `docs/feats/remote-monitoring/F046-merge-on-green.md`

## Why this matters

Root `AGENTS.md` and the Foreman prompt (`agent.md` step 8) say to merge with a merge commit only
when every check on the pull request's exact head commit succeeded. Pending, cancelled and skipped
checks are not green. Nothing enforces it. `record-merge` proves the accepted patch landed, but
not that CI passed on what merged or that the merge kept its co-authored commits. F042 moved Git
and PR integration outside the restricted Foreman, so whoever merges is no longer bound by the
Foreman prompt at all.

## Current state

At `6eda5a9`:

- `recordMerge` (`native.ts:4644`) parses `{ ticket, pr, commit, renames? }` with
  `parseMergeRequest` (`native.ts:943`) and calls `verifyMerge` (`native.ts:1077`). That proves
  the commit is on the fetched upstream and contains the accepted patch. It reads no PR or CI data.
- `permissions.publish` must be `false` (`native.ts:358`, `definition.schema.json:119`), so the
  factory cannot merge itself.
- Nothing in `factory/*.ts` calls `gh`.
- Live reply for PR #103 (recorded in this ticket's thread at `.amp/in/orb-backup/pr103-live.json`):
  `gh pr view 103 --json headRefOid,mergeCommit,state,statusCheckRollup` returned head
  `22d9c32...`, merge commit `6eda5a9...` with two parents, `state: "MERGED"`, and two
  `CheckRun` entries both named `quality` with `status: "COMPLETED"`, `conclusion: "SUCCESS"`.
  The same check name ran twice on one head.

## Approach

Prove the rule at the one place every merge already passes through: `record-merge`. Before saving,
it reads the pull request through one injected adapter. It requires `state: "MERGED"`, the
`mergeCommit` equal to the given `commit`, that commit to have two parents with the second equal
to `headRefOid`, and at least one check with every entry on that head `COMPLETED` and `SUCCESS`
(or a status context in state `SUCCESS`). Neutral, skipped, cancelled, pending and unknown entries
fail. The observed head and checks are stored with the merge record.

A refused merge stays unrecorded and the ticket stays `accepted`. An optional nonempty `decision`
records an operator-approved exception with the observed checks, so the gap stays visible instead
of blocking the queue forever. An unavailable `gh` or failed read refuses; it never passes.

Doing the merge itself is out of scope: it needs publish permission and belongs with
remote-monitoring-ticket1.

## Scope

- In: the PR read adapter, the checks in `record-merge`, the stored check evidence, the
  `decision` exception, tests, README and the Foreman prompt's step 8.
- Out: merging, pushing, subscriptions or polling; existing merge records stay unchanged.
- Out: `record-landing`, which already carries an operator `decision` for outside landings.

## Steps

1. **Read the pull request**. Add one adapter that returns head, merge commit, state and check
   rollup for a PR number, injected so tests need no credentials.
2. **Require green exact head**. Make `record-merge` refuse unless the rules in Approach hold,
   naming the first failing check or mismatch in the error.
3. **Store check evidence**. Save the observed head and checks with the merge record, and keep
   identical repeats repeat-safe.
4. **Record approved exceptions**. Accept a nonempty `decision` that records a refused merge with
   its observed checks as an operator exception.
5. **Update the delivery docs**. Update README and Foreman step 8 to describe the enforced rule.

Illustrative queue entry, not authorization to change the coordinator queue or dispatch work.

```json
{
  "id": "F046-merge-on-green",
  "brief": "Implement docs/feats/remote-monitoring/F046-merge-on-green.md",
  "after": [],
  "size": "medium",
  "risky": true,
  "steps": [
    "Read the pull request",
    "Require green exact head",
    "Store check evidence",
    "Record approved exceptions",
    "Update the delivery docs"
  ]
}
```

## Test plan

Fixtures copy the recorded PR #103 reply and vary one field at a time, with real Git merges in a
disposable repository.

- PR #103's shape with two `quality` runs both `SUCCESS` records.
- One of the two `quality` runs `CANCELLED`, `SKIPPED`, `NEUTRAL` or `IN_PROGRESS`: refused.
- Empty check rollup: refused.
- A squash merge (one parent), or a second parent that is not `headRefOid`: refused.
- `mergeCommit` different from the given `commit`, or `state` not `MERGED`: refused.
- Adapter throws: refused, nothing saved.
- A refused merge with a `decision` records once, stores the checks and the decision; repeating it
  is a no-op and changing it is a conflict.
- Existing records saved before this ticket still read and repeat unchanged.
- Full configured gate and the required cold post-graft review on the exact candidate.

## Why this approach?

- Without this structure: "merge only on green" depends on whoever clicks merge, and a red or
  squash merge is recorded as `merged` just like a clean one.
- This buys: every path into `merged` already goes through `record-merge`, so one check there
  covers all mergers without the factory gaining publish rights. Stored evidence makes an
  exception visible instead of silent.

## Files You'll Touch

| Path                                     | Role              | Contains                        | Edit or Read |
| ---------------------------------------- | ----------------- | ------------------------------- | ------------ |
| `factory/native.ts`                      | Coordinator       | `recordMerge`, request parser   | Edit         |
| `factory/plugin.ts`                      | Native adapter    | PR read adapter wiring          | Edit         |
| `factory/persistence.ts`                 | Durable types     | Merge record evidence fields    | Edit         |
| `factory/native.test.ts`                 | Lifecycle proof   | Check and merge-shape cases     | Edit         |
| `factory/plugin.test.ts`                 | Adapter proof     | Recorded `gh` reply shape       | Edit         |
| `factory/dashboard.ts`                   | Feed              | Merge record projection         | Read         |
| `factory/config/agents/foreman/agent.md` | Foreman prompt    | Step 8 delivery rule            | Edit         |
| `factory/README.md`                      | Operator contract | Record a merged pull request    | Edit         |

Build order: adapter and its fixture, persistence fields, `record-merge` checks and tests, then
the exception, prompt and README.

## Initial state / preflight

Not run while authoring. The coordinator runs these before dispatch.

| Command                                                         | Expected result / action               |
| --------------------------------------------------------------- | -------------------------------------- |
| `git rev-parse HEAD`                                            | Record; explain drift from `6eda5a9`.  |
| `git status --short`                                            | Account for existing edits.            |
| `git diff --stat 6eda5a9..HEAD -- factory/`                     | Revalidate the line references above.  |
| `gh pr view 103 --json headRefOid,mergeCommit,state,statusCheckRollup` | Matches the recorded shape.     |
| `bun install --frozen-lockfile`                                 | Succeeds.                              |
| `bun run lint:ci && bun run typecheck`                          | No errors.                             |
| `bun run format:check`                                          | Passes.                                |
| `bun test`                                                      | Baseline passes; record the count.     |
| `bun run fallow:ci`                                             | Passes without suppressions.           |

## Done when

- [ ] `record-merge` refuses every failing case in the test plan and records PR #103's shape.
- [ ] Recorded merges store the observed head and checks; old records are unchanged.
- [ ] An operator `decision` records a refused merge as a visible exception.
- [ ] Repository CI stays credential-free; tests use the injected adapter.
- [ ] The exact clean candidate passes the full gate and required cold post-graft review.
- [ ] Live proof: the next real ticket merge records through the new checks.
